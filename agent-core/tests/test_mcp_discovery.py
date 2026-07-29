from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_core.tools.mcp_client import MCPServerConnection


class FakeListToolsSession:
    def __init__(self, remote_tools):
        self._remote_tools = remote_tools

    async def list_tools(self):
        return SimpleNamespace(tools=self._remote_tools)


def _remote_tool(name, description="", input_schema=None):
    return SimpleNamespace(name=name, description=description, inputSchema=input_schema)


@pytest.mark.asyncio
async def test_discover_tools_applies_prefix_and_keeps_remote_name():
    remote_tools = [
        _remote_tool("query_prometheus", "Run PromQL"),
        _remote_tool("query_loki_logs", "Run LogQL"),
    ]
    connection = MCPServerConnection("http://unused", name="grafana")
    connection.session = FakeListToolsSession(remote_tools)  # skip the real SSE handshake

    tools = await connection.discover_tools(prefix="grafana_")

    names = {t.name for t in tools}
    remote_names = {t.remote_name for t in tools}
    assert names == {"grafana_query_prometheus", "grafana_query_loki_logs"}
    assert remote_names == {"query_prometheus", "query_loki_logs"}


@pytest.mark.asyncio
async def test_discover_tools_without_session_raises():
    connection = MCPServerConnection("http://unused")
    with pytest.raises(RuntimeError):
        await connection.discover_tools()


@pytest.mark.asyncio
async def test_discover_tools_only_filter_limits_registered_set():
    """Reproduces a real scenario: the server returns 65 tools (on-call
    scheduling, incidents, plugins, ...), while the agent needs only a
    fraction of them for diagnosis.
    """
    remote_tools = [
        _remote_tool("query_prometheus"),
        _remote_tool("query_loki_logs"),
        _remote_tool("get_current_oncall_users"),  # expected to be filtered out
        _remote_tool("install_plugin"),  # expected to be filtered out
    ]
    connection = MCPServerConnection("http://unused", name="grafana")
    connection.session = FakeListToolsSession(remote_tools)

    tools = await connection.discover_tools(
        prefix="grafana_",
        only={"query_prometheus", "query_loki_logs"},
    )

    assert {t.remote_name for t in tools} == {"query_prometheus", "query_loki_logs"}
    assert len(tools) == 2  # not 4 — the rest is filtered out


@pytest.mark.asyncio
async def test_discover_tools_predicate_filter():
    remote_tools = [
        _remote_tool("query_prometheus"),
        _remote_tool("update_dashboard"),
        _remote_tool("delete_snapshot"),
    ]
    connection = MCPServerConnection("http://unused", name="grafana")
    connection.session = FakeListToolsSession(remote_tools)

    tools = await connection.discover_tools(
        predicate=lambda name: not name.startswith(("update_", "delete_")),
    )

    assert {t.remote_name for t in tools} == {"query_prometheus"}
