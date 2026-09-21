from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from qdrant_client import QdrantClient

from app.api.health import router as health_router
from app.config import Settings
from app.rag.embeddings import EmbeddingProvider, build_embedder


def create_app(
    settings: Settings | None = None,
    embedder: EmbeddingProvider | None = None,
    qdrant: QdrantClient | None = None,
) -> FastAPI:
    """Fabryka aplikacji — testy wstrzykują tu fake'i (FakeEmbedder,
    QdrantClient(":memory:")) zamiast realnych zasobów budowanych w lifespanie."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings or Settings()
        app.state.embedder = embedder or build_embedder(app.state.settings)
        app.state.qdrant = qdrant or QdrantClient(url=app.state.settings.qdrant_url)
        yield

    app = FastAPI(title="IDAR RAG API", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health_router)
    return app


app = create_app()
