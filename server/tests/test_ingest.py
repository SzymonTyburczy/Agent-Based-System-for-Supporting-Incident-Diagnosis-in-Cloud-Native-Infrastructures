import re

from fastapi.testclient import TestClient
from qdrant_client import QdrantClient

from app.rag.ids import doc_id, point_id
from app.rag.store import QdrantStore, collection_name

DOC_A = "# Runbook A\n\nPod restartuje się w pętli CrashLoopBackOff. Sprawdź logi kontenera."


def payload(tresc: str = DOC_A, autor: str = "Jan Kowalski", data: str = "2026-08-21") -> dict:
    return {"data": data, "autor": autor, "tresc": tresc}


def test_doc_and_point_ids_are_deterministic():
    assert doc_id("abc") == doc_id("abc")
    assert doc_id("abc") != doc_id("abd")
    assert re.fullmatch(r"[0-9a-f]{16}", doc_id("abc"))
    assert point_id("x", 0) == point_id("x", 0)
    assert point_id("x", 0) != point_id("x", 1)


def test_collection_name_encodes_model_and_dimension():
    assert collection_name("qwen3-embedding:0.6b", 1024) == "kb__qwen3_embedding_0_6b__1024__v1"


def test_alias_flips_to_new_model_collection():
    client = QdrantClient(":memory:")
    store = QdrantStore(client, alias="kb_active")

    first = store.ensure_collection("model-a", 8)
    assert store.collection == first

    second = store.ensure_collection("model-b", 16)
    assert store.collection == second
    # Stara kolekcja zostaje do porównań A/B — alias tylko się przepina.
    assert client.collection_exists(first)


def test_ingest_creates_document_and_lists_it(client: TestClient):
    response = client.post("/api/documents", json=payload())

    assert response.status_code == 201
    body = response.json()
    assert re.fullmatch(r"[0-9a-f]{16}", body["doc_id"])
    assert body["title"] == "Runbook A"
    assert body["chunk_count"] >= 1
    assert body["already_exists"] is False

    listing = client.get("/api/documents").json()
    assert len(listing["documents"]) == 1
    document = listing["documents"][0]
    assert document["doc_id"] == body["doc_id"]
    assert document["author"] == "Jan Kowalski"
    assert document["doc_date"] == "2026-08-21"
    assert document["chunk_count"] == body["chunk_count"]


def test_reingest_same_content_is_idempotent(client: TestClient):
    first = client.post("/api/documents", json=payload())
    second = client.post("/api/documents", json=payload(autor="Ktoś Inny"))

    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["already_exists"] is True
    assert second.json()["doc_id"] == first.json()["doc_id"]
    assert second.json()["chunk_count"] == first.json()["chunk_count"]
    assert len(client.get("/api/documents").json()["documents"]) == 1


def test_delete_document(client: TestClient):
    created = client.post("/api/documents", json=payload()).json()

    deleted = client.delete(f"/api/documents/{created['doc_id']}")
    assert deleted.status_code == 204
    assert client.get("/api/documents").json()["documents"] == []

    again = client.delete(f"/api/documents/{created['doc_id']}")
    assert again.status_code == 404


def test_rejects_invalid_payloads(client: TestClient):
    assert client.post("/api/documents", json={"autor": "X", "tresc": "T"}).status_code == 422
    assert client.post("/api/documents", json=payload(data="21-08-2026")).status_code == 422
    assert client.post("/api/documents", json=payload(tresc="   ")).status_code == 422
    assert client.post("/api/documents", json=payload(autor="  ")).status_code == 422


def test_heading_only_document_is_rejected(client: TestClient):
    response = client.post("/api/documents", json=payload(tresc="# Tylko nagłówek"))

    assert response.status_code == 422
    assert "no indexable content" in response.json()["detail"]
