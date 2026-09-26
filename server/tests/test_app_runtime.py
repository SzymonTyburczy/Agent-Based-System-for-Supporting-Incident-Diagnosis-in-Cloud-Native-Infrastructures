"""Zachowania potrzebne w kontenerze: sondy, CORS z env, token, retry startu."""

import pytest
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient

from app.config import Settings
from app.main import create_app, with_retries
from tests.conftest import FakeEmbedder


def make_client(**overrides) -> TestClient:
    settings = Settings(_env_file=None, **overrides)
    app = create_app(settings=settings, embedder=FakeEmbedder(), qdrant=QdrantClient(":memory:"))
    return TestClient(app)


def test_healthz_is_a_shallow_liveness_probe(client: TestClient):
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_healthz_is_hidden_from_the_api_schema(client: TestClient):
    assert "/healthz" not in client.get("/openapi.json").json()["paths"]


def test_cors_origins_parse_from_comma_separated_env():
    listed = Settings(_env_file=None, cors_origins=" http://a:1, http://b:2 ,")
    blank = Settings(_env_file=None, cors_origins="  ")

    assert listed.cors_origin_list() == ["http://a:1", "http://b:2"]
    assert blank.cors_origin_list() == ["*"]


def test_cors_headers_follow_settings():
    with make_client(cors_origins="http://panel.local") as client:
        allowed = client.options(
            "/api/search",
            headers={
                "Origin": "http://panel.local",
                "Access-Control-Request-Method": "POST",
            },
        )
        denied = client.options(
            "/api/search",
            headers={
                "Origin": "http://evil.local",
                "Access-Control-Request-Method": "POST",
            },
        )

    assert allowed.headers["access-control-allow-origin"] == "http://panel.local"
    assert "access-control-allow-origin" not in denied.headers


def test_api_is_open_when_no_token_is_configured():
    with make_client(api_token="") as client:
        assert client.get("/api/documents").status_code == 200


def test_api_requires_bearer_token_when_configured():
    with make_client(api_token="s3cret") as client:
        assert client.get("/api/documents").status_code == 401
        assert (
            client.get("/api/documents", headers={"Authorization": "Bearer wrong"}).status_code
            == 401
        )
        assert client.post("/api/search", json={"query": "x"}).status_code == 401
        assert (
            client.get("/api/documents", headers={"Authorization": "Bearer s3cret"}).status_code
            == 200
        )


def test_probes_stay_open_with_token_configured():
    with make_client(api_token="s3cret") as client:
        assert client.get("/healthz").status_code == 200
        assert client.get("/api/health").status_code == 200


def test_with_retries_returns_after_transient_failures():
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise ConnectionError("not yet")
        return "ready"

    assert with_retries("dep", flaky, attempts=5, delay=0) == "ready"
    assert len(calls) == 3


def test_with_retries_raises_the_last_error_when_exhausted():
    def broken():
        raise ConnectionError("still down")

    with pytest.raises(ConnectionError, match="still down"):
        with_retries("dep", broken, attempts=3, delay=0)


def test_startup_retries_apply_to_qdrant_collection_setup():
    class FlakyQdrant:
        """Pretends to be a Qdrant that answers only from the third call on."""

        def __init__(self):
            self.inner = QdrantClient(":memory:")
            self.failures_left = 2

        def __getattr__(self, name):
            if self.failures_left:
                self.failures_left -= 1
                raise ConnectionError("qdrant starting")
            return getattr(self.inner, name)

    settings = Settings(_env_file=None, startup_retries=5, startup_retry_seconds=0)
    app = create_app(settings=settings, embedder=FakeEmbedder(), qdrant=FlakyQdrant())

    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
