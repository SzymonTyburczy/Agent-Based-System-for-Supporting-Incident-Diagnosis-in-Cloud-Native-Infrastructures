import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.models import AlertRequest
from app.agent import run_diagnosis
from app.mock_data import SCENARIOS

app = FastAPI(
    title="Incident Diagnosis System",
    description="Agent-Based System for Supporting Incident Diagnosis in Cloud-Native Infrastructures",
    version="0.1.0",
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


# Serve frontend static files — must be LAST to not shadow API routes
static_dir = os.path.join(os.path.dirname(__file__), "..", "static")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
