import re

import pytest
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient

from app.config import Settings
from app.rag import store as store_module
from app.rag.chunking import Chunk
from app.rag.ids import doc_id, point_id
from app.rag.ingest import IngestResult, ingest_document
from app.rag.store import DocumentMeta, QdrantStore, collection_name

DOC_A = "# Runbook A\n\nThe pod restarts in a CrashLoopBackOff loop. Check the container logs."


def payload(content: str = DOC_A, author: str = "Jane Doe", date: str = "2026-08-21") -> dict:
    # The team's frozen wire contract (app/schemas.py).
    return {"data": date, "autor": author, "tresc": content}


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
    # The old collection stays for A/B comparisons; only the alias moves.
    assert client.collection_exists(first)


def _store_with_upsert_spy(monkeypatch, fail_on_request: int | None = None, dimension: int = 4):
    """A store on in-memory Qdrant that records the size of every upsert
    request and can fail one of them."""
    client = QdrantClient(":memory:")
    store = QdrantStore(client, alias="kb_active")
    store.ensure_collection("model-a", dimension)
    requests: list[int] = []
    real_upsert = client.upsert

    def upsert(**kwargs):
        requests.append(len(kwargs["points"]))
        if len(requests) == fail_on_request:
            raise RuntimeError("Qdrant rejected the request")
        return real_upsert(**kwargs)

    monkeypatch.setattr(client, "upsert", upsert)
    return store, requests


def _five_chunks() -> tuple[DocumentMeta, list[Chunk], list[list[float]]]:
    meta = DocumentMeta(
        doc_id="doc-a",
        title="Runbook A",
        author="Jane Doe",
        doc_date="2026-08-21",
        embedding_model="model-a",
        ingested_at="2026-08-21T00:00:00+00:00",
    )
    chunks = [Chunk(text=f"chunk {i}", section_path=("Runbook A",), index=i) for i in range(5)]
    vectors = [[1.0, 0.0, 0.0, float(i)] for i in range(5)]
    return meta, chunks, vectors


def test_upsert_is_split_into_batches_and_stores_every_chunk(monkeypatch):
    monkeypatch.setattr(store_module, "UPSERT_BATCH_SIZE", 2)
    store, requests = _store_with_upsert_spy(monkeypatch)

    store.upsert_chunks(*_five_chunks())

    assert requests == [2, 2, 1]
    assert store.count_chunks("doc-a") == 5


def test_failed_batch_leaves_no_half_written_document(monkeypatch):
    monkeypatch.setattr(store_module, "UPSERT_BATCH_SIZE", 2)
    store, requests = _store_with_upsert_spy(monkeypatch, fail_on_request=2)

    with pytest.raises(RuntimeError):
        store.upsert_chunks(*_five_chunks())

    # The first batch was written before the failure; a retry must not see the
    # document as already ingested.
    assert requests == [2, 2]
    assert not store.document_exists("doc-a")


RUNBOOK_IN_FIVE_SECTIONS = "# Runbook B\n\n" + "\n\n".join(
    f"## Step {i}\n\nRestart pod number {i} and check its logs." for i in range(5)
)


def test_reingest_completes_a_document_whose_cleanup_also_failed(monkeypatch, fake_embedder):
    monkeypatch.setattr(store_module, "UPSERT_BATCH_SIZE", 2)
    store, _ = _store_with_upsert_spy(
        monkeypatch, fail_on_request=2, dimension=fake_embedder.dimension
    )
    document_id = doc_id(RUNBOOK_IN_FIVE_SECTIONS)

    def ingest() -> IngestResult:
        return ingest_document(
            doc_date="2026-08-21",
            author="Jane Doe",
            content=RUNBOOK_IN_FIVE_SECTIONS,
            store=store,
            embedder=fake_embedder,
            settings=Settings(_env_file=None),
        )

    def unreachable(*args, **kwargs):
        raise ConnectionError("Qdrant is unreachable")

    # Qdrant goes away mid-ingest, so the cleanup's delete fails too and the
    # first batch stays behind.
    with monkeypatch.context() as down:
        down.setattr(QdrantClient, "delete", unreachable)
        with pytest.raises(ConnectionError):
            ingest()
    assert store.count_chunks(document_id) == 2

    # The next upload must finish the document, not report it as already
    # ingested with a truncated chunk_count.
    retried = ingest()
    assert retried.already_exists is False
    assert retried.chunk_count == 5
    assert store.count_chunks(document_id) == 5
    assert ingest().already_exists is True


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
    assert document["author"] == "Jane Doe"
    assert document["doc_date"] == "2026-08-21"
    assert document["chunk_count"] == body["chunk_count"]


def test_reingest_same_content_is_idempotent(client: TestClient):
    first = client.post("/api/documents", json=payload())
    second = client.post("/api/documents", json=payload(author="Someone Else"))

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
    assert client.post("/api/documents", json=payload(date="21-08-2026")).status_code == 422
    assert client.post("/api/documents", json=payload(content="   ")).status_code == 422
    assert client.post("/api/documents", json=payload(author="  ")).status_code == 422


def test_payload_accepts_only_the_contract_keys(client: TestClient):
    body = {"doc_date": "2026-08-21", "author": "Jane Doe", "content": DOC_A}

    assert client.post("/api/documents", json=body).status_code == 422


def test_heading_only_document_is_rejected(client: TestClient):
    response = client.post("/api/documents", json=payload(content="# Just a heading"))

    assert response.status_code == 422
    assert "no indexable content" in response.json()["detail"]
