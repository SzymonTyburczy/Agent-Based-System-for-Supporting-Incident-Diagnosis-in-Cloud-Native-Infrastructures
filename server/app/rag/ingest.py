from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import batched

from app.config import Settings
from app.rag.chunking import build_chunks, extract_title
from app.rag.embeddings import EmbeddingProvider
from app.rag.ids import doc_id as compute_doc_id
from app.rag.store import DocumentMeta, QdrantStore

EMBED_BATCH_SIZE = 32


@dataclass(frozen=True)
class IngestResult:
    doc_id: str
    title: str
    chunk_count: int
    already_exists: bool


def ingest_document(
    *,
    data: str,
    autor: str,
    tresc: str,
    store: QdrantStore,
    embedder: EmbeddingProvider,
    settings: Settings,
) -> IngestResult:
    document_id = compute_doc_id(tresc)
    title = extract_title(tresc) or f"Dokument {document_id[:8]}"

    if store.document_exists(document_id):
        return IngestResult(
            doc_id=document_id,
            title=title,
            chunk_count=store.count_chunks(document_id),
            already_exists=True,
        )

    chunks = build_chunks(
        tresc,
        max_tokens=settings.chunk_max_tokens,
        overlap_tokens=settings.chunk_overlap_tokens,
        breadcrumbs=settings.breadcrumbs,
    )
    if not chunks:
        raise ValueError("The document has no indexable content besides headings.")

    vectors: list[list[float]] = []
    for batch in batched(chunks, EMBED_BATCH_SIZE):
        vectors.extend(embedder.embed_documents([chunk.text for chunk in batch]))

    meta = DocumentMeta(
        doc_id=document_id,
        title=title,
        author=autor,
        doc_date=data,
        embedding_model=embedder.model_id,
        ingested_at=datetime.now(UTC).isoformat(),
    )
    store.upsert_chunks(meta, chunks, vectors)
    return IngestResult(
        doc_id=document_id, title=title, chunk_count=len(chunks), already_exists=False
    )
