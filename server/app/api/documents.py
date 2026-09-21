from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response

from app.config import Settings
from app.deps import get_embedder, get_settings, get_store
from app.rag.embeddings import EmbeddingProvider
from app.rag.ingest import ingest_document
from app.rag.store import QdrantStore
from app.schemas import (
    DocumentIn,
    DocumentIngestResponse,
    DocumentListResponse,
    DocumentSummary,
)

router = APIRouter()


@router.post("/api/documents", status_code=201, response_model=DocumentIngestResponse)
def create_document(
    payload: DocumentIn,
    response: Response,
    store: Annotated[QdrantStore, Depends(get_store)],
    embedder: Annotated[EmbeddingProvider, Depends(get_embedder)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> DocumentIngestResponse:
    try:
        result = ingest_document(
            data=payload.data.isoformat(),
            autor=payload.autor,
            tresc=payload.tresc,
            store=store,
            embedder=embedder,
            settings=settings,
        )
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err

    if result.already_exists:
        # Duplikat to nie błąd — idempotencja zamiast 409.
        response.status_code = 200
    return DocumentIngestResponse(
        doc_id=result.doc_id,
        title=result.title,
        chunk_count=result.chunk_count,
        already_exists=result.already_exists,
    )


@router.get("/api/documents", response_model=DocumentListResponse)
def list_documents(
    store: Annotated[QdrantStore, Depends(get_store)],
) -> DocumentListResponse:
    return DocumentListResponse(
        documents=[DocumentSummary(**summary) for summary in store.list_documents()]
    )


@router.delete("/api/documents/{doc_id}", status_code=204)
def delete_document(
    doc_id: str,
    store: Annotated[QdrantStore, Depends(get_store)],
) -> None:
    if not store.delete_document(doc_id):
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found.")
