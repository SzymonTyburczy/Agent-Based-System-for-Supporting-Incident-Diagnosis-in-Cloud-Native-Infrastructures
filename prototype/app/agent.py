"""
Agent Orchestrator — simulates the multi-step agent workflow:
ALERT_RECEIVED → ANALYZING_METRICS → QUERYING_LOGS → RAG_SEARCH → GENERATING_REPORT → REPORT_COMPLETE

Each step is yielded as a Server-Sent Event so the frontend can animate them live.
RAG_SEARCH now uses real ChromaDB vector similarity search.
"""

import asyncio
import json
from typing import AsyncGenerator

from app.mock_data import SCENARIOS
from app.gemini import generate_diagnosis_stream
from app.rag import query_knowledge_base


async def run_diagnosis(scenario_id: str, custom_scenario: dict | None = None) -> AsyncGenerator[str, None]:
    """
    Main agent pipeline. Yields SSE-formatted strings.
    """
    if custom_scenario:
        scenario = custom_scenario
    else:
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

    # Step 4: RAG search — real vector similarity search in ChromaDB
    rag_query = _build_rag_query(scenario)
    rag_docs = await asyncio.get_event_loop().run_in_executor(
        None, lambda: query_knowledge_base(rag_query, top_k=5)
    )

    yield _sse_event(
        "RAG_SEARCH",
        f"Retrieved {len(rag_docs)} relevant documentation chunks via semantic search (ChromaDB + text-embedding-004).",
        {
            "query": rag_query,
            "documents": [
                {"source": d["source"], "distance": d["distance"]}
                for d in rag_docs
            ],
        },
    )
    await asyncio.sleep(0.8)

    # Step 5: Generating report via Gemini (streaming)
    yield _sse_event(
        "GENERATING_REPORT",
        "Sending telemetry and retrieved documentation context to Gemini AI for diagnosis...",
    )

    # Stream Gemini response chunk by chunk
    report_chunks = []
    async for chunk in generate_diagnosis_stream(scenario, rag_docs):
        report_chunks.append(chunk)
        yield _sse_event("REPORT_CHUNK", chunk)

    # Final event with complete report
    yield _sse_event(
        "REPORT_COMPLETE",
        "Diagnostic report generated successfully.",
        {"full_report": "".join(report_chunks)},
    )


def _build_rag_query(scenario: dict) -> str:
    """
    Build a rich query string for vector similarity search.
    Combines alert type, service name, and key metric values.
    """
    metrics = scenario["metrics"]
    # Pick the most diagnostic metric values
    key_metrics = {
        k: v for k, v in metrics.items()
        if isinstance(v, (int, float)) and k not in ("pod_count",)
    }
    metric_str = ", ".join(
        f"{k.replace('_', ' ')}: {v}"
        for k, v in list(key_metrics.items())[:4]
    )
    return (
        f"{scenario['alert_type']} {scenario['name']} "
        f"service {scenario['service']} namespace {scenario['namespace']}. "
        f"{scenario['description']} {metric_str}"
    )


def _sse_event(step: str, message: str, data: dict | None = None) -> str:
    """Format a Server-Sent Event string."""
    payload = {"step": step, "message": message}
    if data:
        payload["data"] = data
    return f"data: {json.dumps(payload)}\n\n"
