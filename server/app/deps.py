from fastapi import Request
from qdrant_client import QdrantClient

from app.config import Settings
from app.rag.embeddings import EmbeddingProvider
from app.rag.store import QdrantStore


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_embedder(request: Request) -> EmbeddingProvider:
    return request.app.state.embedder


def get_qdrant(request: Request) -> QdrantClient:
    return request.app.state.qdrant


def get_store(request: Request) -> QdrantStore:
    return request.app.state.store
