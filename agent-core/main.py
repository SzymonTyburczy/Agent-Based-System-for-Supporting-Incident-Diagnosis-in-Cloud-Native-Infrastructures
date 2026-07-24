"""Continuously polls the Grafana MCP server for firing alerts and runs the
diagnostic agent whenever the firing set changes — this is the thesis's
"react to monitoring alerts" premise, without yet building the full
event-driven Slack webhook path (that's the integration component's job).

Requires the reference infrastructure to be running (deploy-stack.ps1 /
deploy-stack.sh) with port forwarding active, so that http://localhost:8000/sse
responds.

Run with:
    export LLM_PROVIDER=openai        # or anthropic / ollama
    export OPENAI_API_KEY=...         # depending on the chosen provider
    python main.py                    # runs forever; Ctrl+C to stop
    AGENT_RUN_ONCE=true python main.py  # single investigation, then exit
"""

from __future__ import annotations

import asyncio
import logging
import time

from agent_core.agent.loop import AgentConfig, AgentLoop
from agent_core.config import Settings, build_provider
from agent_core.incident import (
    alerts_signature,
    build_incident_description,
    build_system_prompt,
)
from agent_core.llm.base import LLMProvider
from agent_core.report import generate_report, save_report
from agent_core.tools.cli_tools import KubectlGetPodsTool, KubectlPodDiagnosticsTool
from agent_core.tools.mcp_client import MCPServerConnection
from agent_core.tools.registry import ToolRegistry

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
# Third-party HTTP/transport chatter (one line per SSE message, per retry,
# ...) drowns out the agent's own decision trail. Keep it at WARNING so
# actual problems there still surface, without burying the business logs.
for _noisy_logger in ("httpx", "openai", "openai._base_client", "mcp"):
    logging.getLogger(_noisy_logger).setLevel(logging.WARNING)
logger = logging.getLogger("demo")

# Used only in single-shot mode (AGENT_RUN_ONCE=true) when no alert is
# currently firing — see run_once().
FALLBACK_QUESTION = (
    "Customers are reporting errors during checkout in the OpenTelemetry "
    "Demo Store (namespace otel-demo). Diagnose the root cause using the "
    "available metrics, logs, and pod status."
)


async def build_registry(settings: Settings, mcp: MCPServerConnection) -> ToolRegistry:
    registry = ToolRegistry()

    # Local (CLI) tools — work independently of MCP.
    namespaces = settings.kubectl_namespaces()
    registry.register(KubectlGetPodsTool(allowed_namespaces=namespaces))
    registry.register(KubectlPodDiagnosticsTool(allowed_namespaces=namespaces))

    # Tools discovered from the MCP server, restricted to an allowlist.
    # Without this, mcp-grafana can return 60+ tools (on-call scheduling,
    # incidents, plugins, ...), and every one of their schemas is sent to the
    # model on EVERY turn of the ReAct loop — a fast way to exhaust the
    # tokens-per-minute (TPM) rate limit before even reaching the actual
    # conversation content.
    allowlist = settings.mcp_tool_allowlist()
    mcp_tools = await mcp.discover_tools(
        prefix=settings.mcp_grafana_tool_prefix,
        only=allowlist,
    )
    if allowlist is None:
        logger.warning(
            "MCP_GRAFANA_TOOL_ALLOWLIST is empty — registered ALL tools from the "
            "MCP server (%d). This risks LLM rate limits as the tool count grows — "
            "consider narrowing it down in .env.",
            len(mcp_tools),
        )
    registry.register_many(mcp_tools)

    logger.info(
        "Registered %d tools in total (including %d from MCP): %s",
        len(registry),
        len(mcp_tools),
        [t.name for t in registry],
    )
    return registry


async def fetch_firing_alerts_raw(tools: ToolRegistry, tool_name: str) -> str | None:
    """Calls the Grafana alerting tool for currently firing/pending alert
    rules and returns its raw (text) result, or None if the tool isn't
    registered or the call failed.

    Always calls with operation="list" — this tool also supports
    create/update/delete, which this agent must never trigger itself
    (see incident.SYSTEM_PROMPT_TEMPLATE guideline 6, and the
    --disable-write note in .env.example).
    """
    if tool_name not in tools:
        logger.info("Alerting tool '%s' is not registered — skipping alert lookup.", tool_name)
        return None

    result = await tools.call(tool_name, {"operation": "list", "states": ["firing"]})
    if not result.success:
        logger.warning("Could not fetch firing alerts via %s: %s", tool_name, result.error)
        return None
    return result.as_text()


async def investigate(
    provider: LLMProvider,
    registry: ToolRegistry,
    max_iterations: int,
    incident_description: str,
    report_output_dir: str,
) -> None:
    """Runs one full agent investigation, prints its transcript, and saves a
    structured JSON report (title, error sources, problem, remediations) to
    disk.
    """
    loop = AgentLoop(
        provider=provider,
        tools=registry,
        config=AgentConfig(
            max_iterations=max_iterations,
            system_prompt=build_system_prompt(),
        ),
    )

    started = time.monotonic()
    state = await loop.run(incident_description)
    logger.info(
        "Investigation finished in %.1fs (%d messages in the transcript).",
        time.monotonic() - started,
        len(state.messages),
    )

    final_message = state.messages[-1]
    if final_message.content:
        report = await generate_report(provider, final_message.content)
        path = save_report(report, report_output_dir)
        logger.info("Saved incident report to %s", path)

    print("\n=== CONVERSATION TRANSCRIPT ===\n")
    for message in state.messages:
        print(f"--- {message.role.value} ---")
        if message.content:
            print(message.content)
        for call in message.tool_calls:
            print(f"[tool call] {call.name}({call.arguments})")
        print()


async def run_once(
    settings: Settings,
    provider: LLMProvider,
    registry: ToolRegistry,
    alerting_tool_name: str,
) -> None:
    """Single-shot mode: one investigation, then return. Useful for a quick
    smoke test without waiting for a real alert to fire.
    """
    alerts_raw = await fetch_firing_alerts_raw(registry, alerting_tool_name)
    incident_description = build_incident_description(alerts_raw, FALLBACK_QUESTION)

    if incident_description == FALLBACK_QUESTION:
        logger.info("No firing alerts found — falling back to the static example question.")
    else:
        logger.info("Firing alert(s) found — driving the investigation from live alerting data.")

    await investigate(
        provider,
        registry,
        settings.agent_max_iterations,
        incident_description,
        settings.report_output_dir,
    )


async def run_continuously(
    settings: Settings,
    provider: LLMProvider,
    registry: ToolRegistry,
    alerting_tool_name: str,
) -> None:
    """Polls for firing alerts forever, starting a fresh investigation only
    when the firing set actually changes since the last one (see
    incident.alerts_signature) — so an alert that stays firing across many
    poll cycles triggers exactly one investigation, not one per cycle.
    """
    logger.info(
        "Starting continuous polling every %ds. Press Ctrl+C to stop.",
        settings.agent_poll_interval_seconds,
    )
    last_signature: str | None = None

    while True:
        alerts_raw = await fetch_firing_alerts_raw(registry, alerting_tool_name)
        signature = alerts_signature(alerts_raw)

        if signature is None:
            logger.info("No firing alerts.")
        elif signature == last_signature:
            logger.info("Firing alerts unchanged since the last investigation — skipping.")
        else:
            logger.info("New or changed firing alert(s) detected — starting an investigation.")
            incident_description = build_incident_description(alerts_raw, FALLBACK_QUESTION)
            await investigate(
                provider,
                registry,
                settings.agent_max_iterations,
                incident_description,
                settings.report_output_dir,
            )
            last_signature = signature

        await asyncio.sleep(settings.agent_poll_interval_seconds)


async def main() -> None:
    settings = Settings()
    provider = build_provider(settings)
    logger.info("LLM provider: %s", settings.llm_provider)

    async with MCPServerConnection(settings.mcp_grafana_url, name="grafana") as mcp:
        registry = await build_registry(settings, mcp)
        alerting_tool_name = f"{settings.mcp_grafana_tool_prefix}alerting_manage_rules"

        if settings.agent_run_once:
            await run_once(settings, provider, registry, alerting_tool_name)
        else:
            await run_continuously(settings, provider, registry, alerting_tool_name)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Stopped by user (Ctrl+C).")
