from typing import Annotated

from fastapi import Header, HTTPException, Request
from qdrant_client import QdrantClient

from app.config import Settings
from app.rag.embeddings import EmbeddingProvider
from app.rag.store import QdrantStore


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def require_api_token(
    request: Request, authorization: Annotated[str | None, Header()] = None
) -> None:
    """Strażnik /api/documents i /api/search: aktywny tylko, gdy ustawiono
    IDAR_API_TOKEN (jak CLIENT_API_TOKEN agenta i API_TOKEN konwertera)."""
    token = request.app.state.settings.api_token
    if not token or authorization == f"Bearer {token}":
        return
    raise HTTPException(status_code=401, detail="invalid or missing Authorization header")


def get_embedder(request: Request) -> EmbeddingProvider:
    return request.app.state.embedder


def get_qdrant(request: Request) -> QdrantClient:
    return request.app.state.qdrant


def get_store(request: Request) -> QdrantStore:
    return request.app.state.store
