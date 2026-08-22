import zlib

import pytest
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient

from app.main import create_app
from app.rag.embeddings import l2_normalize


class FakeEmbedder:
    """Deterministyczny bag-of-words (CRC32 tokenów) — testuje hydraulikę
    pipeline'u, nigdy semantykę; semantykę mierzy wyłącznie harness ewaluacyjny."""

    model_id = "fake"
    dimension = 64

    def _vec(self, text: str) -> list[float]:
        vector = [0.0] * self.dimension
        for token in text.lower().split():
            vector[zlib.crc32(token.encode()) % self.dimension] += 1.0
        return l2_normalize(vector)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


@pytest.fixture
def fake_embedder() -> FakeEmbedder:
    return FakeEmbedder()


@pytest.fixture
def client(fake_embedder: FakeEmbedder):
    app = create_app(embedder=fake_embedder, qdrant=QdrantClient(":memory:"))
    with TestClient(app) as test_client:
        yield test_client
