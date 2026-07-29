from __future__ import annotations

from typing import Any, Iterable, Iterator

from agent_core.llm.base import ToolSchema
from agent_core.tools.base import Tool, ToolResult


class ToolRegistry:
    """Registry of tools available to the agent.

    Tools can originate from different sources (static CLI definitions,
    auto-discovery from an MCP server) — the registry is agnostic to that,
    it only stores `Tool` objects.
    """

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool, *, overwrite: bool = False) -> None:
        if tool.name in self._tools and not overwrite:
            raise ValueError(
                f"Tool '{tool.name}' is already registered "
                "(pass overwrite=True if this is intentional)."
            )
        self._tools[tool.name] = tool

    def register_many(self, tools: Iterable[Tool], *, overwrite: bool = False) -> None:
        for tool in tools:
            self.register(tool, overwrite=overwrite)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def schemas(self) -> list[ToolSchema]:
        return [tool.to_schema() for tool in self._tools.values()]

    async def call(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        tool = self.get(name)
        if tool is None:
            return ToolResult(success=False, error=f"Unknown tool: '{name}'")
        try:
            return await tool.execute(**arguments)
        except TypeError as exc:
            # usually: the model invoked the tool with wrong/missing arguments
            return ToolResult(success=False, error=f"Invalid arguments: {exc}")
        except Exception as exc:  # tools must never crash the agent
            return ToolResult(success=False, error=str(exc))

    def __len__(self) -> int:
        return len(self._tools)

    def __iter__(self) -> Iterator[Tool]:
        return iter(self._tools.values())

    def __contains__(self, name: str) -> bool:
        return name in self._tools
