"""Citations wired through both entry points: the real search tool (HTTP
mocked) registers its hits in the scope the entry point opened, and the
saved / stored / broadcast report carries the resolved citations.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

import main
import webhook_server as wh
from agent_core.config import Settings
from agent_core.incident import IncidentMeta
from agent_core.llm.base import LLMProvider, LLMResponse, ToolCall
from agent_core.report_events import ReportEventBroadcaster
from agent_core.reports_store import ReportsStore
from agent_core.tools.rag import SearchKnowledgeBaseTool
from agent_core.tools.registry import ToolRegistry

HIT = {
    "text": "Pods > Diagnosis\n\nCheck the previous container logs.",
    "score": 0.83,
    "doc_id": "runbook-1",
    "title": "Pod restart runbook",
    "section_path": ["Pods", "Diagnosis"],
    "author": "SRE",
    "doc_date": "2026-10-03",
    "chunk_index": 2,
    "file_name": "pod-restarts.md",
}
EXPECTED_CITATION = {
    "key": "KB1",
    "doc_id": "runbook-1",
    "file_name": "pod-restarts.md",
    "title": "Pod restart runbook",
    "section_path": ["Pods", "Diagnosis"],
    "chunk_index": 2,
    "quote": "Check the previous container logs.",
}


class ScriptedProvider(LLMProvider):
    """Searches once, answers with a cited diagnosis, then structures it.
    [KB5] was never handed out, so it must not survive into the report.
    """

    def __init__(self) -> None:
        self._responses = [
            LLMResponse(
                content=None,
                tool_calls=[
                    ToolCall(
                        id="rag",
                        name="search_knowledge_base",
                        arguments={"query": "pod restarts"},
                    )
                ],
            ),
            LLMResponse(content="Pods are OOM-killed [KB1] [KB5].", tool_calls=[]),
            LLMResponse(
                content=json.dumps(
                    {
                        "title": "OOM kills",
                        "summary": "Pods are OOM-killed.",
                        "problem": "The pods are OOM-killed [KB1] [KB5].",
                        "error_sources": [],
                        "remediations": [],
                    }
                ),
                tool_calls=[],
            ),
        ]

    async def complete(self, messages, tools=None, **kwargs):
        return self._responses.pop(0)


@pytest.fixture
def registry(monkeypatch) -> ToolRegistry:
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "results": [HIT],
                "embedding_model": "test-model",
                "collection": "kb_test",
            },
        )
    )
    monkeypatch.setattr(
        "agent_core.tools.rag.httpx.AsyncClient",
        lambda **kwargs: original_client(transport=transport, **kwargs),
    )
    registry = ToolRegistry()
    registry.register(SearchKnowledgeBaseTool("http://rag"))
    return registry


async def test_webhook_worker_stores_and_broadcasts_citations(registry, tmp_path, monkeypatch):
    settings = Settings(_env_file=None, report_output_dir=str(tmp_path), agent_max_iterations=3)
    store = ReportsStore(":memory:")
    broadcaster = ReportEventBroadcaster()
    monkeypatch.setattr(wh.state, "settings", settings)
    monkeypatch.setattr(wh.state, "provider", ScriptedProvider())
    monkeypatch.setattr(wh.state, "registry", registry)
    monkeypatch.setattr(wh.state, "reports_store", store)
    monkeypatch.setattr(wh.state, "broadcaster", broadcaster)
    monkeypatch.setattr(wh.state, "queue", asyncio.Queue())
    events = broadcaster.subscribe()

    worker = asyncio.create_task(wh._worker())
    try:
        await wh.state.queue.put(
            wh.QueuedIncident(
                description="Pods restarting",
                meta=IncidentMeta(service="checkout", severity="critical"),
            )
        )
        await asyncio.wait_for(wh.state.queue.join(), timeout=5)
    finally:
        worker.cancel()

    [record] = store.list_reports()
    assert record.problem == "The pods are OOM-killed [KB1]."
    assert record.citations == [EXPECTED_CITATION]
    assert "- [KB1] pod-restarts.md — Pods > Diagnosis" in record.content_md
    event = events.get_nowait()
    assert event.event == "report_created"
    assert event.data["citations"] == [EXPECTED_CITATION]
    store.close()


async def test_polling_investigation_saves_citations(registry, tmp_path):
    await main.investigate(ScriptedProvider(), registry, 3, "Pods restarting", str(tmp_path))

    [path] = tmp_path.glob("*-report.json")
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["problem"] == "The pods are OOM-killed [KB1]."
    assert saved["citations"] == [EXPECTED_CITATION]
