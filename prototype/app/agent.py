"""
Agent Orchestrator — simulates the multi-step agent workflow:
ALERT_RECEIVED → ANALYZING_METRICS → QUERYING_LOGS → RAG_SEARCH → GENERATING_REPORT → REPORT_COMPLETE
Each step is yielded as a Server-Sent Event so the frontend can animate them live.
"""

import asyncio
import json
from typing import AsyncGenerator

from app.mock_data import SCENARIOS
from app.gemini import generate_diagnosis_stream


async def run_diagnosis(scenario_id: str) -> AsyncGenerator[str, None]:
    """
    Main agent pipeline. Yields SSE-formatted strings.
    """
    scenario = SCENARIOS.get(scenario_id)
    if not scenario:
        yield _sse_event("ERROR", f"Unknown scenario: {scenario_id}")
        return

    # Step 1: Alert received
    yield _sse_event(
        "ALERT_RECEIVED",
        f"Alert received: [{scenario['alert_type']}] on {scenario['service']} in namespace '{scenario['namespace']}'.",
        {
            "alert_type": scenario["alert_type"],
            "severity": scenario["severity"],
            "service": scenario["service"],
            "namespace": scenario["namespace"],
        },
    )
    await asyncio.sleep(0.8)

    # Step 2: Analyzing metrics
    yield _sse_event(
        "ANALYZING_METRICS",
        f"Fetching live metrics from Prometheus for service '{scenario['service']}'...",
        scenario["metrics"],
    )
    await asyncio.sleep(1.2)

    # Step 3: Querying logs
    yield _sse_event(
        "QUERYING_LOGS",
        f"Querying Elasticsearch for recent log entries ({len(scenario['logs'])} entries found)...",
        {"logs": scenario["logs"]},
    )
    await asyncio.sleep(1.0)

    # Step 4: RAG search
    yield _sse_event(
        "RAG_SEARCH",
        f"Retrieving relevant documentation ({len(scenario['rag_docs'])} documents matched)...",
        {"documents": [doc["source"] for doc in scenario["rag_docs"]]},
    )
    await asyncio.sleep(0.8)

    # Step 5: Generating report via Gemini (streaming)
    yield _sse_event(
        "GENERATING_REPORT",
        "Sending telemetry and documentation context to Gemini AI for diagnosis...",
    )

    # Stream Gemini response chunk by chunk
    report_chunks = []
    async for chunk in generate_diagnosis_stream(scenario):
        report_chunks.append(chunk)
        yield _sse_event("REPORT_CHUNK", chunk)

    # Final event with complete report
    yield _sse_event(
        "REPORT_COMPLETE",
        "Diagnostic report generated successfully.",
        {"full_report": "".join(report_chunks)},
    )


def _sse_event(step: str, message: str, data: dict | None = None) -> str:
    """Format a Server-Sent Event string."""
    payload = {"step": step, "message": message}
    if data:
        payload["data"] = data
    return f"data: {json.dumps(payload)}\n\n"
