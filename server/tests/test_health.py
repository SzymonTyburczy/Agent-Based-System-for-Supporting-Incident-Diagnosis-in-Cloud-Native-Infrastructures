from fastapi.testclient import TestClient
from qdrant_client import QdrantClient

from app.main import create_app
from tests.conftest import FakeEmbedder


class BrokenEmbedder(FakeEmbedder):
    def embed_query(self, text: str) -> list[float]:
        raise RuntimeError("embedding engine down")


def test_health_reports_ok_with_model_and_dimension(client: TestClient):
    response = client.get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["qdrant"] == "ok"
    assert body["embedding"] == "ok"
    assert body["embedding_model"] == "fake"
    assert body["dimension"] == 64


def test_health_degraded_when_embedding_fails():
    app = create_app(embedder=BrokenEmbedder(), qdrant=QdrantClient(":memory:"))
    with TestClient(app) as client:
        response = client.get("/api/health")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["embedding"].startswith("error:")
