import pytest
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient

DOC_PODS = (
    "# Runbook: CrashLoopBackOff\n\n"
    "Pod restartuje się w pętli. Sprawdź logi kontenera poleceniem kubectl logs."
)
DOC_GRAFANA = (
    "# Runbook: Grafana datasource\n\n"
    "Dashboard nie pokazuje danych. Sprawdź konfigurację datasource Prometheus w Grafanie."
)
DOC_OOM = (
    "# Runbook: OOMKilled\n\n"
    "Kontener zabity przez limit pamięci. Zwiększ limity memory w manifeście wdrożenia."
)

QUERY_PODS = "restartuje logi kontenera kubectl"


def seed(client: TestClient) -> dict[str, str]:
    documents = {
        "pods": ("Ala", "2026-08-01", DOC_PODS),
        "grafana": ("Ola", "2026-08-10", DOC_GRAFANA),
        "oom": ("Ala", "2026-08-20", DOC_OOM),
    }
    ids: dict[str, str] = {}
    for key, (autor, data, tresc) in documents.items():
        response = client.post(
            "/api/documents", json={"data": data, "autor": autor, "tresc": tresc}
        )
        assert response.status_code == 201
        ids[key] = response.json()["doc_id"]
    return ids


def search(client: TestClient, **body) -> dict:
    response = client.post("/api/search", json={"query": QUERY_PODS, **body})
    assert response.status_code == 200
    return response.json()


def test_search_returns_best_match_first(client: TestClient):
    ids = seed(client)

    body = search(client)

    assert body["results"]
    top = body["results"][0]
    assert top["doc_id"] == ids["pods"]
    assert top["title"] == "Runbook: CrashLoopBackOff"
    assert top["section_path"] == ["Runbook: CrashLoopBackOff"]
    assert body["embedding_model"] == "fake"
    assert body["collection"].startswith("kb__fake__64__")


def test_top_k_limits_results(client: TestClient):
    seed(client)

    assert len(search(client, top_k=2)["results"]) == 2
    assert len(search(client)["results"]) == 3


def test_author_filter_narrows_results(client: TestClient):
    ids = seed(client)

    results = search(client, filters={"author": "Ola"})["results"]

    assert results
    assert all(r["doc_id"] == ids["grafana"] for r in results)


def test_date_range_filter_narrows_results(client: TestClient):
    ids = seed(client)

    results = search(client, filters={"date_from": "2026-08-15"})["results"]

    assert results
    assert all(r["doc_id"] == ids["oom"] for r in results)


def test_score_threshold_can_filter_everything_out(client: TestClient):
    seed(client)

    assert search(client, score_threshold=0.999)["results"] == []


def test_search_request_validation(client: TestClient):
    assert client.post("/api/search", json={"query": ""}).status_code == 422
    assert client.post("/api/search", json={"query": "x", "top_k": 0}).status_code == 422
    assert client.post("/api/search", json={"query": "x", "top_k": 50}).status_code == 422


@pytest.mark.slow
def test_polish_question_hits_the_right_runbook_semantically():
    from app.config import Settings
    from app.rag.embeddings import build_embedder
    from app.rag.ingest import ingest_document
    from app.rag.store import QdrantStore

    settings = Settings()
    embedder = build_embedder(settings)
    store = QdrantStore(QdrantClient(":memory:"), alias=settings.collection_alias)
    store.ensure_collection(embedder.model_id, embedder.dimension)

    ids = {}
    for key, tresc in (("pods", DOC_PODS), ("grafana", DOC_GRAFANA), ("oom", DOC_OOM)):
        result = ingest_document(
            data="2026-08-21",
            autor="Test",
            tresc=tresc,
            store=store,
            embedder=embedder,
            settings=settings,
        )
        ids[key] = result.doc_id

    vector = embedder.embed_query("pod ciągle się restartuje, jak znaleźć przyczynę?")
    points = store.query(vector, top_k=3)

    assert points
    assert points[0].payload["doc_id"] == ids["pods"]
