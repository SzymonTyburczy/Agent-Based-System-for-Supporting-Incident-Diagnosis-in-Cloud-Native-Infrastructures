import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from agent_core.agent.loop import AgentConfig, AgentLoop
from agent_core.config import Settings
from agent_core.llm.base import LLMResponse, Role, ToolCall
from agent_core.tools.rag import SearchKnowledgeBaseTool
from agent_core.tools.registry import ToolRegistry


HIT = {
    "text": "Check the previous container logs for CrashLoopBackOff.",
    "score": 0.83, "doc_id": "runbook-1", "title": "Pod restart runbook",
    "section_path": ["Pods", "Diagnosis"], "author": "SRE",
    "doc_date": "2026-10-03", "chunk_index": 0,
}
PAYLOAD = {"results": [HIT], "embedding_model": "test-model", "collection": "kb_test"}


@pytest.fixture
def mock_http(monkeypatch):
    original_client = httpx.AsyncClient

    def install(handler):
        transport = httpx.MockTransport(handler)
        monkeypatch.setattr(
            "agent_core.tools.rag.httpx.AsyncClient",
            lambda **kwargs: original_client(transport=transport, **kwargs),
        )

    return install


async def test_search_contract_and_auth(mock_http):
    def respond(request):
        assert str(request.url) == "http://rag:8080/api/search"
        assert request.headers["Authorization"] == "Bearer private-token"
        assert json.loads(request.content) == {"query": "pod restarts", "top_k": 3}
        return httpx.Response(200, json=PAYLOAD)

    mock_http(respond)
    result = await SearchKnowledgeBaseTool(
        "http://rag:8080/", token="private-token", top_k=3,
    ).execute(" pod restarts ")
    assert result.success
    assert result.data["results"][0] == {**HIT, "truncated": False}


async def test_empty_results_are_success_and_no_token_is_sent(mock_http):
    def respond(request):
        assert "authorization" not in request.headers
        return httpx.Response(200, json={**PAYLOAD, "results": []})

    mock_http(respond)
    result = await SearchKnowledgeBaseTool("http://rag").execute("unknown incident")
    assert result.success and result.data["results"] == []


@pytest.mark.parametrize("status", [401, 403, 500, 503])
async def test_http_failures_do_not_leak_response_bodies(mock_http, status):
    mock_http(lambda request: httpx.Response(status, text="sensitive backend details"))
    result = await SearchKnowledgeBaseTool("http://rag").execute("pod restart")
    assert not result.success
    assert str(status) in result.error
    assert "sensitive" not in result.as_text()


@pytest.mark.parametrize("error", [httpx.ReadTimeout, httpx.ConnectError])
async def test_transport_failure_is_a_tool_error(mock_http, error):
    def respond(request):
        raise error("private connection details", request=request)

    mock_http(respond)
    result = await SearchKnowledgeBaseTool("http://rag").execute("pod restart")
    assert not result.success
    assert "private" not in result.error


@pytest.mark.parametrize("body", ["<html>error</html>", '{}', '{"results": [null]}'])
async def test_invalid_response(mock_http, body):
    mock_http(lambda request: httpx.Response(200, text=body))
    result = await SearchKnowledgeBaseTool("http://rag").execute("pod restart")
    assert not result.success and "invalid search response" in result.error


async def test_total_deadline_cancels_a_stalled_request(mock_http):
    async def respond(request):
        await asyncio.sleep(10)
        return httpx.Response(200, json=PAYLOAD)

    mock_http(respond)
    result = await SearchKnowledgeBaseTool("http://rag", timeout=0.01).execute("restart")
    assert not result.success and "timed out" in result.error


@pytest.mark.parametrize("query", ["", "  ", 42, "x" * 2001])
async def test_invalid_query_is_rejected_without_http(query):
    result = await SearchKnowledgeBaseTool("http://unused").execute(query)
    assert not result.success


async def test_limits_context_but_preserves_source(mock_http):
    hit = {**HIT, "text": "x" * 5000}
    mock_http(lambda request: httpx.Response(200, json={**PAYLOAD, "results": [hit] * 4}))
    result = await SearchKnowledgeBaseTool("http://rag", top_k=2).execute("pod restart")
    assert len(result.data["results"]) == 2
    assert len(result.data["results"][0]["text"]) == 4000
    assert result.data["results"][0]["truncated"]
    assert result.data["results"][0]["doc_id"] == HIT["doc_id"]


@pytest.mark.parametrize("entrypoint", ["main", "webhook_server"])
@pytest.mark.parametrize("enabled", [False, True])
async def test_both_entrypoints_register_rag_only_when_configured(entrypoint, enabled):
    import importlib

    module = importlib.import_module(entrypoint)
    settings = Settings(_env_file=None, rag_api_url="http://rag" if enabled else "")
    mcp = AsyncMock()
    mcp.discover_tools.return_value = []
    registry = await module.build_registry(settings, mcp)
    assert ("search_knowledge_base" in registry) is enabled


@pytest.mark.parametrize("status", [200, 503])
async def test_retrieval_result_or_failure_reaches_next_llm_turn(mock_http, status):
    mock_http(lambda request: httpx.Response(status, json=PAYLOAD))
    registry = ToolRegistry()
    registry.register(SearchKnowledgeBaseTool("http://rag"))
    provider = AsyncMock()
    seen = []

    async def complete(messages, **kwargs):
        seen.append(list(messages))
        if len(seen) == 1:
            return LLMResponse(content=None, tool_calls=[ToolCall(
                id="rag-call", name="search_knowledge_base",
                arguments={"query": "pod restarts"},
            )])
        return LLMResponse(content="Continue diagnosis using telemetry.", tool_calls=[])

    provider.complete.side_effect = complete
    state = await AgentLoop(
        provider=provider, tools=registry, config=AgentConfig(max_iterations=3),
    ).run("Diagnose restarting pod")
    tool_messages = [message for message in seen[1] if message.role == Role.TOOL]
    if status == 200:
        assert json.loads(tool_messages[0].content)["results"][0]["doc_id"] == "runbook-1"
    else:
        assert "ERROR:" in tool_messages[0].content
        assert "503" in tool_messages[0].content
    assert state.messages[-1].content == "Continue diagnosis using telemetry."
