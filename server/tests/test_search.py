import pytest
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient

DOC_PODS = (
    "# Runbook: CrashLoopBackOff\n\n"
    "The pod restarts in a loop. Check the container logs with kubectl logs."
)
DOC_GRAFANA = (
    "# Runbook: Grafana datasource\n\n"
    "The dashboard shows no data. Check the Prometheus datasource configuration in Grafana."
)
DOC_OOM = (
    "# Runbook: OOMKilled\n\n"
    "The container was killed by its memory limit. Raise the memory limits in the deployment."
)

QUERY_PODS = "restarts container logs kubectl"

# Polish on purpose: runbooks in the knowledge base may be written in Polish, so the
# real model must match a Polish question to the right one as well.
RUNBOOKS_PL = {
    "pods": (
        "# Runbook: CrashLoopBackOff\n\n"
        "Pod restartuje się w pętli. Sprawdź logi kontenera poleceniem kubectl logs."
    ),
    "grafana": (
        "# Runbook: Grafana datasource\n\n"
        "Dashboard nie pokazuje danych. Sprawdź konfigurację datasource Prometheus w Grafanie."
    ),
    "oom": (
        "# Runbook: OOMKilled\n\n"
        "Kontener zabity przez limit pamięci. Zwiększ limity memory w manifeście wdrożenia."
    ),
}
RUNBOOKS_EN = {"pods": DOC_PODS, "grafana": DOC_GRAFANA, "oom": DOC_OOM}


def seed(client: TestClient) -> dict[str, str]:
    documents = {
        "pods": ("Alice", "2026-08-01", DOC_PODS),
        "grafana": ("Bob", "2026-08-10", DOC_GRAFANA),
        "oom": ("Alice", "2026-08-20", DOC_OOM),
    }
    ids: dict[str, str] = {}
    for key, (author, date, content) in documents.items():
        response = client.post(
            "/api/documents", json={"data": date, "autor": author, "tresc": content}
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

    results = search(client, filters={"author": "Bob"})["results"]

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
@pytest.mark.parametrize(
    ("runbooks", "question"),
    [
        (RUNBOOKS_EN, "the pod keeps restarting, how do I find the cause?"),
        (RUNBOOKS_PL, "pod ciągle się restartuje, jak znaleźć przyczynę?"),
    ],
    ids=["english", "polish"],
)
def test_question_hits_the_right_runbook_semantically(runbooks: dict[str, str], question: str):
    from app.config import Settings
    from app.rag.embeddings import build_embedder
    from app.rag.ingest import ingest_document
    from app.rag.store import QdrantStore

    settings = Settings()
    embedder = build_embedder(settings)
    store = QdrantStore(QdrantClient(":memory:"), alias=settings.collection_alias)
    store.ensure_collection(embedder.model_id, embedder.dimension)

    ids = {}
    for key, content in runbooks.items():
        result = ingest_document(
            doc_date="2026-08-21",
            author="Test",
            content=content,
            store=store,
            embedder=embedder,
            settings=settings,
        )
        ids[key] = result.doc_id

    vector = embedder.embed_query(question)
    points = store.query(vector, top_k=3)

    assert points
    assert points[0].payload["doc_id"] == ids["pods"]
