import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.models import AlertRequest
from app.agent import run_diagnosis
from app.mock_data import SCENARIOS
from app.rag import initialize_rag, get_collection_stats

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize RAG (ChromaDB + embeddings) on startup."""
    logger.info("Initializing RAG knowledge base...")
    try:
        initialize_rag()
        stats = get_collection_stats()
        logger.info(f"RAG ready: {stats['document_count']} chunks indexed in ChromaDB.")
    except Exception as e:
        logger.error(f"RAG initialization failed: {e}")
        logger.warning("System will run without RAG (Gemini reports will have no documentation context).")
    yield
    logger.info("Shutting down.")


app = FastAPI(
    title="IncidentIQ — Incident Diagnosis System",
    description="Agent-Based System for Supporting Incident Diagnosis in Cloud-Native Infrastructures",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/scenarios")
async def get_scenarios():
    """Return list of available incident scenarios."""
    return [
        {
            "id": s["id"],
            "name": s["name"],
            "alert_type": s["alert_type"],
            "severity": s["severity"],
            "service": s["service"],
            "namespace": s["namespace"],
            "description": s["description"],
        }
        for s in SCENARIOS.values()
    ]


@app.post("/api/diagnose")
async def diagnose(request: AlertRequest):
    """
    Start incident diagnosis pipeline.
    Returns a Server-Sent Events stream with agent steps and the final Gemini report.
    """
    if request.scenario_id not in SCENARIOS:
        raise HTTPException(status_code=404, detail=f"Scenario '{request.scenario_id}' not found.")

    return StreamingResponse(
        run_diagnosis(request.scenario_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/rag/stats")
async def rag_stats():
    """Return ChromaDB collection statistics."""
    return get_collection_stats()


# Serve frontend static files — must be LAST to not shadow API routes
static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
