"""Integration with MCP servers (e.g. `grafana/mcp-grafana` from the reference
observability infrastructure).

Approach: `MCPServerConnection` manages the connection (SSE transport) and the
MCP session lifecycle, while `discover_tools()` converts every tool returned
by `list_tools()` into an `MCPTool` object that conforms to our internal
`Tool` interface. As a result, the agent sees tools coming from MCP exactly
the same way it sees CLI-backed tools from `cli_tools.py` — there is no
MCP-specific logic in the agent loop or in the ToolRegistry.
"""

from __future__ import annotations

from contextlib import AsyncExitStack
from typing import Any, Callable, Iterable

from mcp import ClientSession
from mcp.client.sse import sse_client

from agent_core.tools.base import Tool, ToolResult


class MCPTool(Tool):
    """Adapter that exposes a single MCP-server tool through the internal Tool interface."""

    def __init__(
        self,
        session: ClientSession,
        *,
        name: str,
        remote_name: str,
        description: str | None,
        input_schema: dict[str, Any] | None,
    ) -> None:
        self.name = name
        self.remote_name = remote_name  # the name the MCP server knows this tool by
        self.description = description or f"MCP tool '{remote_name}'"
        self.parameters_schema = input_schema or {"type": "object", "properties": {}}
        self._session = session

    async def execute(self, **kwargs: Any) -> ToolResult:
        try:
            result = await self._session.call_tool(self.remote_name, arguments=kwargs)
        except Exception as exc:
            return ToolResult(success=False, error=f"MCP call failed: {exc}")

        text = _extract_text(result)
        if getattr(result, "isError", False):
            return ToolResult(success=False, error=text or "The MCP server reported an error.")
        return ToolResult(success=True, data=text)


def _extract_text(result: Any) -> str:
    parts = []
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts) if parts else str(result)


class MCPServerConnection:
    """Manages the SSE connection to a single MCP server and discovers its tools.

    Usage:
        async with MCPServerConnection(url, name="grafana") as mcp:
            tools = await mcp.discover_tools(prefix="grafana_")
            registry.register_many(tools)
    """

    def __init__(
        self,
        url: str,
        *,
        name: str = "mcp",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.url = url
        self.name = name
        self.headers = headers or {}
        self._stack = AsyncExitStack()
        self.session: ClientSession | None = None

    async def __aenter__(self) -> "MCPServerConnection":
        read, write = await self._stack.enter_async_context(
            sse_client(self.url, headers=self.headers)
        )
        self.session = await self._stack.enter_async_context(ClientSession(read, write))
        await self.session.initialize()
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self._stack.aclose()

    async def discover_tools(
        self,
        *,
        prefix: str | None = None,
        only: Iterable[str] | None = None,
        predicate: Callable[[str], bool] | None = None,
    ) -> list[MCPTool]:
        """Fetches the tool list from the server and converts it into MCPTool objects.

        `prefix` avoids name collisions when the ToolRegistry holds tools from
        several MCP servers at once (e.g. "grafana_" vs "github_").

        `only` / `predicate` restrict which tools get registered (matched
        against the REMOTE tool name, i.e. the one reported by the MCP
        server, before `prefix` is applied). This matters in practice:
        MCP servers (e.g. mcp-grafana) can return dozens of tools from
        categories that are irrelevant for a given agent (on-call scheduling,
        incident management, plugins...) — every extra registered tool adds
        tokens to EVERY LLM call (the schema is resent on every turn of the
        ReAct loop), so registering everything "just in case" measurably
        increases the risk of hitting tokens-per-minute (TPM) rate limits,
        not just cluttering the context.
        """
        if self.session is None:
            raise RuntimeError("MCPServerConnection must be used inside an 'async with' block.")

        only_set = set(only) if only is not None else None

        listed = await self.session.list_tools()
        tools: list[MCPTool] = []
        skipped = 0
        for remote_tool in listed.tools:
            if only_set is not None and remote_tool.name not in only_set:
                skipped += 1
                continue
            if predicate is not None and not predicate(remote_tool.name):
                skipped += 1
                continue

            local_name = f"{prefix}{remote_tool.name}" if prefix else remote_tool.name
            tools.append(
                MCPTool(
                    self.session,
                    name=local_name,
                    remote_name=remote_tool.name,
                    description=remote_tool.description,
                    input_schema=remote_tool.inputSchema,
                )
            )

        if skipped:
            import logging

            logging.getLogger(__name__).info(
                "Skipped %d/%d tools from MCP server '%s' (outside the allowlist/predicate).",
                skipped,
                len(listed.tools),
                self.name,
            )
        return tools
