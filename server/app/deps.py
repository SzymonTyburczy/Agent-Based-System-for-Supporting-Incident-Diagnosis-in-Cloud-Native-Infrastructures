from fastapi import Request
from qdrant_client import QdrantClient

from app.rag.embeddings import EmbeddingProvider


def get_embedder(request: Request) -> EmbeddingProvider:
    return request.app.state.embedder


def get_qdrant(request: Request) -> QdrantClient:
    return request.app.state.qdrant
