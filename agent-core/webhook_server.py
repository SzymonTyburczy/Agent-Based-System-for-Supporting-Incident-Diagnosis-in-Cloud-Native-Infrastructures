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
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request

from agent_core.agent.loop import AgentConfig, AgentLoop
from agent_core.config import Settings, build_provider
from agent_core.incident import build_incident_description_from_webhook, build_system_prompt
from agent_core.llm.base import LLMProvider
from agent_core.report import generate_report, save_report
from agent_core.tools.cli_tools import KubectlGetPodsTool, KubectlPodDiagnosticsTool
from agent_core.tools.mcp_client import MCPServerConnection
from agent_core.tools.registry import ToolRegistry

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
for _noisy_logger in ("httpx", "openai", "openai._base_client", "mcp", "uvicorn.access"):
    logging.getLogger(_noisy_logger).setLevel(logging.WARNING)
logger = logging.getLogger("webhook")


class AppState:
    """Long-lived pieces built once at startup and shared across requests:
    the MCP connection, tool registry, LLM provider, and the queue + worker
    that serialize investigations (see module docstring).
    """

    def __init__(self) -> None:
        self.settings: Settings | None = None
        self.provider: LLMProvider | None = None
        self.registry: ToolRegistry | None = None
        self.mcp: MCPServerConnection | None = None
        self.queue: asyncio.Queue[str] = asyncio.Queue()
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

    while True:
        incident_description = await state.queue.get()
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
            result_state = await loop.run(incident_description)
            logger.info(
                "Investigation finished in %.1fs (%d messages).",
                time.monotonic() - started,
                len(result_state.messages),
            )
            # Delivering this to Slack (formatting, threading, etc.) is the
            # integration component's job — see README, "Integration points
            # for the rest of the team". For now the result is logged AND
            # saved as a structured JSON report on disk.
            final_message = result_state.messages[-1]
            if final_message.content:
                logger.info("Diagnosis:\n%s", final_message.content)
                report = await generate_report(state.provider, final_message.content)
                path = save_report(report, state.settings.report_output_dir)
                logger.info("Saved incident report to %s", path)
        except Exception:
            logger.exception("Investigation failed unexpectedly.")
        finally:
            state.queue.task_done()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings()
    state.settings = settings
    state.provider = build_provider(settings)
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


app = FastAPI(lifespan=lifespan)


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

    await state.queue.put(incident_description)
    logger.info("Queued investigation from webhook (queue depth now %d).", state.queue.qsize())
    return {"status": "queued"}


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}
