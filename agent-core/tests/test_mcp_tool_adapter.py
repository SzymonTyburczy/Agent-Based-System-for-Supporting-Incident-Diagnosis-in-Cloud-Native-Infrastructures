from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_core.tools.mcp_client import MCPTool


class FakeSession:
    """Simulates mcp.ClientSession to the extent MCPTool.execute() needs."""

    def __init__(self, *, is_error: bool = False, text: str = "") -> None:
        self.last_call: tuple[str, dict] | None = None
        self._is_error = is_error
        self._text = text

    async def call_tool(self, name: str, arguments: dict):
        self.last_call = (name, arguments)
        return SimpleNamespace(
            isError=self._is_error,
            content=[SimpleNamespace(text=self._text)],
        )


@pytest.mark.asyncio
async def test_mcp_tool_calls_remote_name_with_arguments_and_extracts_text():
    session = FakeSession(text="42 series returned")
    tool = MCPTool(
        session,
        name="grafana_query_prometheus",  # local (prefixed) name
        remote_name="query_prometheus",  # name known to the MCP server
        description="Run PromQL",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
    )

    result = await tool.execute(query="up")

    # key architectural assertion: the tool can be registered under a
    # prefixed name, but the actual call goes to the server under the
    # original remote name
    assert session.last_call == ("query_prometheus", {"query": "up"})
    assert result.success is True
    assert result.data == "42 series returned"


@pytest.mark.asyncio
async def test_mcp_tool_propagates_server_side_error():
    session = FakeSession(is_error=True, text="datasource unreachable")
    tool = MCPTool(
        session,
        name="query_loki_logs",
        remote_name="query_loki_logs",
        description=None,
        input_schema=None,
    )

    result = await tool.execute(query='{app="checkout"}')

    assert result.success is False
    assert result.error == "datasource unreachable"


def test_mcp_tool_falls_back_to_default_schema_and_description():
    session = FakeSession()
    tool = MCPTool(session, name="x", remote_name="x", description=None, input_schema=None)

    assert tool.parameters_schema == {"type": "object", "properties": {}}
    assert "x" in tool.description
