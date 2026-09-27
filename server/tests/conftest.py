import zlib

import pytest
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient

from app.config import Settings
from app.main import create_app
from app.rag.embeddings import l2_normalize


class FakeEmbedder:
    """Deterministic bag-of-words (CRC32 of the tokens). It tests the pipeline's
    plumbing, never semantics; only the evaluation harness measures semantics."""

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
    # _env_file=None: a developer's local .env (e.g. IDAR_API_TOKEN) does not
    # affect the tests.
    app = create_app(
        settings=Settings(_env_file=None),
        embedder=fake_embedder,
        qdrant=QdrantClient(":memory:"),
    )
    with TestClient(app) as test_client:
        yield test_client
