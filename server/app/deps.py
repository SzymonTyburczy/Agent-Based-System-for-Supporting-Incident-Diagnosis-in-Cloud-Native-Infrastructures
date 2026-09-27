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
    """Guards /api/documents and /api/search, only when IDAR_API_TOKEN is set
    (like the agent's CLIENT_API_TOKEN and the converter's API_TOKEN)."""
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
