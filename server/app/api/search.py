from typing import Annotated

from fastapi import APIRouter, Depends

from app.deps import get_embedder, get_store
from app.rag.embeddings import EmbeddingProvider
from app.rag.store import QdrantStore
from app.schemas import SearchRequest, SearchResponse, SearchResult

router = APIRouter()


@router.post("/api/search", response_model=SearchResponse)
def search(
    request: SearchRequest,
    store: Annotated[QdrantStore, Depends(get_store)],
    embedder: Annotated[EmbeddingProvider, Depends(get_embedder)],
) -> SearchResponse:
    vector = embedder.embed_query(request.query)
    points = store.query(
        vector,
        top_k=request.top_k,
        author=request.filters.author,
        date_from=request.filters.date_from,
        date_to=request.filters.date_to,
        score_threshold=request.score_threshold,
    )
    results = [
        SearchResult(
            text=payload["text"],
            score=point.score,
            doc_id=payload["doc_id"],
            title=payload["title"],
            section_path=payload["section_path"],
            author=payload["author"],
            doc_date=payload["doc_date"],
            chunk_index=payload["chunk_index"],
        )
        for point in points
        if (payload := point.payload or {})
    ]
    return SearchResponse(
        results=results,
        embedding_model=embedder.model_id,
        collection=store.collection or store.alias,
    )
