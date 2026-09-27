import logging
import time
from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from qdrant_client import QdrantClient

from app.api.documents import router as documents_router
from app.api.health import router as health_router
from app.api.search import router as search_router
from app.config import Settings
from app.deps import require_api_token
from app.rag.embeddings import EmbeddingProvider, build_embedder
from app.rag.store import QdrantStore

log = logging.getLogger("idar.startup")


def with_retries[T](label: str, build: Callable[[], T], *, attempts: int, delay: float) -> T:
    """Waits for a dependency that starts in parallel with us (containers, K8s).
    The last error propagates: starting without Ollama or Qdrant must fail loudly."""
    attempts = max(attempts, 1)
    for attempt in range(1, attempts + 1):
        try:
            return build()
        except Exception as err:
            if attempt == attempts:
                raise
            log.warning(
                "%s not ready (attempt %d/%d): %s — retrying in %.0fs",
                label,
                attempt,
                attempts,
                err,
                delay,
            )
            time.sleep(delay)
    raise AssertionError("unreachable")


def create_app(
    settings: Settings | None = None,
    embedder: EmbeddingProvider | None = None,
    qdrant: QdrantClient | None = None,
) -> FastAPI:
    """Application factory. Tests inject fakes here (FakeEmbedder,
    QdrantClient(":memory:")) instead of the real resources built in the lifespan."""
    settings = settings or Settings()
    retry = {"attempts": settings.startup_retries, "delay": settings.startup_retry_seconds}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.embedder = embedder or with_retries(
            "embedding provider", lambda: build_embedder(settings), **retry
        )
        app.state.qdrant = qdrant or QdrantClient(url=settings.qdrant_url)
        store = QdrantStore(app.state.qdrant, settings.collection_alias)
        with_retries(
            "Qdrant",
            lambda: store.ensure_collection(
                app.state.embedder.model_id, app.state.embedder.dimension
            ),
            **retry,
        )
        app.state.store = store
        yield

    app = FastAPI(title="IDAR RAG API", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list(),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health_router)
    protected = [Depends(require_api_token)]
    app.include_router(documents_router, dependencies=protected)
    app.include_router(search_router, dependencies=protected)
    return app


app = create_app()
