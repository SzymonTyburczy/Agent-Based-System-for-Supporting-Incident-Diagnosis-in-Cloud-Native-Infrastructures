from typing import Annotated

from fastapi import APIRouter, Depends, Response
from qdrant_client import QdrantClient

from app.deps import get_embedder, get_qdrant
from app.rag.embeddings import EmbeddingProvider

router = APIRouter()


@router.get("/api/health")
def health(
    response: Response,
    embedder: Annotated[EmbeddingProvider, Depends(get_embedder)],
    qdrant: Annotated[QdrantClient, Depends(get_qdrant)],
) -> dict:
    qdrant_status = "ok"
    try:
        qdrant.get_collections()
    except Exception as err:
        qdrant_status = f"error: {err}"

    embedding_status = "ok"
    try:
        embedder.embed_query("health probe")
    except Exception as err:
        embedding_status = f"error: {err}"

    healthy = qdrant_status == "ok" and embedding_status == "ok"
    response.status_code = 200 if healthy else 503
    return {
        "status": "ok" if healthy else "degraded",
        "qdrant": qdrant_status,
        "embedding": embedding_status,
        "embedding_model": embedder.model_id,
        "dimension": embedder.dimension,
    }
