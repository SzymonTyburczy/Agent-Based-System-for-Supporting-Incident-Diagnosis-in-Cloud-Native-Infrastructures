"""FastAPI webhook receiver for Alertmanager notifications — the push-based
alternative to the polling loop in main.py (see README, "Push vs. polling").

Configure Alertmanager's receiver to POST here (see README for the exact
config snippet to add to the infrastructure's Alertmanager values). This
gives near-real-time triggering: Alertmanager itself already groups related
alerts before sending (group_by/group_wait/group_interval), so a single
incident that trips several alert rules at once typically arrives as ONE
webhook call, not one per rule. On top of that, this server processes
incidents one at a time via an internal queue, so even multiple, unrelated
alert groups firing close together cannot launch several concurrent,
budget-burning investigations — extra ones simply wait their turn.

Run with:
    export LLM_PROVIDER=openai        # or anthropic / ollama
    export OPENAI_API_KEY=...
    uvicorn webhook_server:app --host 0.0.0.0 --port 8080

Recommended alongside main.py's polling loop as a reconciliation safety
net (a longer AGENT_POLL_INTERVAL_SECONDS, e.g. 300s+), not as a full
replacement — see README for the resilience argument.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import AsyncIterator, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from agent_core.agent.loop import AgentConfig, AgentLoop
from agent_core.config import Settings, build_provider
from agent_core.incident import (
    IncidentMeta,
    build_incident_description_from_webhook,
    build_system_prompt,
    extract_incident_meta_from_webhook,
)
from agent_core.llm.base import LLMProvider
from agent_core.report import generate_report, render_report_markdown, save_report
from agent_core.report_events import ReportEventBroadcaster
from agent_core.reports_api import ReportDetail, ReportSummary, StatusUpdate
from agent_core.reports_store import ReportRecord, ReportsStore
from agent_core.tools.cli_tools import KubectlGetPodsTool, KubectlPodDiagnosticsTool
from agent_core.tools.mcp_client import MCPServerConnection
from agent_core.tools.registry import ToolRegistry

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
for _noisy_logger in ("httpx", "openai", "openai._base_client", "mcp", "uvicorn.access"):
    logging.getLogger(_noisy_logger).setLevel(logging.WARNING)
logger = logging.getLogger("webhook")

# Loaded at import time (rather than inside `lifespan`) because CORS needs
# it to configure the middleware when `app` is constructed below, before
# the lifespan context ever runs. `lifespan` reuses this same instance —
# see its body — so .env is only read once.
_settings = Settings()


@dataclass
class QueuedIncident:
    """One item on the investigation queue: the free-text description the
    agent loop reasons over, plus the alert's own service/severity labels
    (see incident.extract_incident_meta_from_webhook) — carried alongside
    rather than folded into the description, since these are structured
    facts the reports store needs, not more text for the LLM to restate.
    """

    description: str
    meta: IncidentMeta


class AppState:
    """Long-lived pieces built once at startup and shared across requests:
    the MCP connection, tool registry, LLM provider, the reports store,
    and the queue + worker that serialize investigations (see module
    docstring).
    """

    def __init__(self) -> None:
        self.settings: Settings | None = None
        self.provider: LLMProvider | None = None
        self.registry: ToolRegistry | None = None
        self.mcp: MCPServerConnection | None = None
        self.reports_store: ReportsStore | None = None
        self.broadcaster: ReportEventBroadcaster | None = None
        self.queue: asyncio.Queue[QueuedIncident] = asyncio.Queue()
        self.worker_task: asyncio.Task | None = None


state = AppState()


async def build_registry(settings: Settings, mcp: MCPServerConnection) -> ToolRegistry:
    """Same tool set and allowlist rationale as main.py's build_registry."""
    registry = ToolRegistry()

    namespaces = settings.kubectl_namespaces()
    registry.register(KubectlGetPodsTool(allowed_namespaces=namespaces))
    registry.register(KubectlPodDiagnosticsTool(allowed_namespaces=namespaces))

    allowlist = settings.mcp_tool_allowlist()
    mcp_tools = await mcp.discover_tools(prefix=settings.mcp_grafana_tool_prefix, only=allowlist)
    registry.register_many(mcp_tools)

    logger.info(
        "Registered %d tools in total (including %d from MCP): %s",
        len(registry),
        len(mcp_tools),
        [t.name for t in registry],
    )
    return registry


async def _worker() -> None:
    """Consumes queued incident descriptions one at a time. This is the
    concurrency guard: at most one investigation runs at once, regardless
    of how many webhook calls arrive close together.
    """
    assert state.provider is not None
    assert state.registry is not None
    assert state.settings is not None
    assert state.reports_store is not None

    while True:
        queued = await state.queue.get()
        try:
            loop = AgentLoop(
                provider=state.provider,
                tools=state.registry,
                config=AgentConfig(
                    max_iterations=state.settings.agent_max_iterations,
                    system_prompt=build_system_prompt(),
                ),
            )
            started = time.monotonic()
            result_state = await loop.run(queued.description)
            logger.info(
                "Investigation finished in %.1fs (%d messages).",
                time.monotonic() - started,
                len(result_state.messages),
            )
            # Delivering this to Slack (formatting, threading, etc.) is the
            # integration component's job — see README, "Integration points
            # for the rest of the team". For now the result is logged,
            # saved as a structured JSON report on disk, AND written to the
            # reports store the client's web panel will read from.
            final_message = result_state.messages[-1]
            if final_message.content:
                logger.info("Diagnosis:\n%s", final_message.content)
                report = await generate_report(state.provider, final_message.content)
                path = save_report(report, state.settings.report_output_dir)
                logger.info("Saved incident report to %s", path)

                record = ReportRecord(
                    id=str(uuid.uuid4()),
                    generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    title=report.title,
                    service=queued.meta.service,
                    severity=queued.meta.severity,
                    summary=report.summary,
                    problem=report.problem,
                    error_sources=report.error_sources,
                    remediations=report.remediations,
                    raw_diagnosis=report.raw_diagnosis,
                    content_md=render_report_markdown(report),
                )
                state.reports_store.insert(record)
                logger.info("Recorded report %s in reports store.", record.id)
                if state.broadcaster is not None:
                    await state.broadcaster.publish("report_created", record.to_dict())
        except Exception:
            logger.exception("Investigation failed unexpectedly.")
        finally:
            state.queue.task_done()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = _settings
    state.settings = settings
    state.provider = build_provider(settings)
    state.reports_store = ReportsStore(settings.reports_db_path)
    state.broadcaster = ReportEventBroadcaster()
    logger.info("LLM provider: %s", settings.llm_provider)

    mcp = MCPServerConnection(settings.mcp_grafana_url, name="grafana")
    await mcp.__aenter__()
    state.mcp = mcp
    state.registry = await build_registry(settings, mcp)

    state.worker_task = asyncio.create_task(_worker())
    logger.info(
        "Webhook receiver ready on %s:%d (POST /alerts/webhook).",
        settings.webhook_host,
        settings.webhook_port,
    )

    try:
        yield
    finally:
        if state.worker_task is not None:
            state.worker_task.cancel()
        if state.mcp is not None:
            await state.mcp.__aexit__(None, None, None)
        if state.reports_store is not None:
            state.reports_store.close()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.client_origins(),
    allow_methods=["GET", "PATCH"],
    allow_headers=["Authorization"],
)


async def require_client_token(
    authorization: str | None = Header(default=None),
    token: str | None = None,
) -> None:
    """Auth guard for the /reports* endpoints — separate from the webhook's
    own secret (see Settings.client_api_token) since Alertmanager and the
    web panel are different callers with independent lifecycles.

    Accepts the token either as a Bearer header (REST calls) or as a
    `?token=` query parameter (the SSE stream: browsers' EventSource
    cannot set custom request headers, so the client has no other way to
    authenticate that connection).
    """
    settings = state.settings
    assert settings is not None
    if not settings.client_api_token:
        return
    if authorization == f"Bearer {settings.client_api_token}":
        return
    if token == settings.client_api_token:
        return
    raise HTTPException(status_code=401, detail="invalid or missing Authorization header")


@app.post("/alerts/webhook")
async def alerts_webhook(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict:
    settings = state.settings
    assert settings is not None

    if settings.webhook_shared_secret:
        expected = f"Bearer {settings.webhook_shared_secret}"
        if authorization != expected:
            raise HTTPException(status_code=401, detail="invalid or missing Authorization header")

    payload = await request.json()
    incident_description = build_incident_description_from_webhook(payload)

    if incident_description is None:
        logger.info(
            "Ignoring webhook payload with status=%r (not an actionable firing alert).",
            payload.get("status") if isinstance(payload, dict) else type(payload).__name__,
        )
        return {"status": "ignored"}

    meta = extract_incident_meta_from_webhook(payload)
    await state.queue.put(QueuedIncident(description=incident_description, meta=meta))
    logger.info(
        "Queued investigation from webhook (service=%s, severity=%s, queue depth now %d).",
        meta.service,
        meta.severity,
        state.queue.qsize(),
    )
    return {"status": "queued"}


@app.get("/reports")
async def list_reports(
    status: Literal["pending", "resolved"] | None = None,
    _: None = Depends(require_client_token),
) -> list[ReportSummary]:
    assert state.reports_store is not None
    records = state.reports_store.list_reports(status=status)
    return [ReportSummary.model_validate(record.to_dict()) for record in records]


@app.get("/reports/{report_id}")
async def get_report(
    report_id: str,
    _: None = Depends(require_client_token),
) -> ReportDetail:
    assert state.reports_store is not None
    record = state.reports_store.get(report_id)
    if record is None:
        raise HTTPException(status_code=404, detail="report not found")
    return ReportDetail.model_validate(record.to_dict())


@app.patch("/reports/{report_id}")
async def patch_report_status(
    report_id: str,
    body: StatusUpdate,
    _: None = Depends(require_client_token),
) -> ReportDetail:
    assert state.reports_store is not None
    assert state.broadcaster is not None

    updated = state.reports_store.update_status(report_id, body.status)
    if updated is None:
        raise HTTPException(status_code=404, detail="report not found")

    await state.broadcaster.publish("report_updated", updated.to_dict())
    return ReportDetail.model_validate(updated.to_dict())


@app.get("/reports/stream")
async def reports_stream(
    request: Request,
    _: None = Depends(require_client_token),
) -> StreamingResponse:
    """Server-Sent Events push for the web panel: `report_created` when a
    finished investigation lands in the store, `report_updated` when a
    status changes (from this connection or any other client's PATCH).
    Polling /reports still works and is what populates the initial list —
    this is only the live-update layer on top.
    """
    assert state.broadcaster is not None
    queue = state.broadcaster.subscribe()

    async def event_source() -> AsyncIterator[str]:
        try:
            yield ": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": keep-alive\n\n"  # comment line, ignored by EventSource
                    continue
                yield event.to_sse()
        finally:
            state.broadcaster.unsubscribe(queue)

    return StreamingResponse(event_source(), media_type="text/event-stream")


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}
