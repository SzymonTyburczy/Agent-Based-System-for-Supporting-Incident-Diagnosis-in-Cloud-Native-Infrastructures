"""Common interface for tools.

Key architectural assumption: the agent does not need to know whether a
`Tool.execute()` call runs a local CLI command (kubectl, awscli) or a remote
call through MCP (e.g. query_prometheus on the mcp-grafana server). Both
categories implement exactly the same interface.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from agent_core.llm.base import ToolSchema


@dataclass
class ToolResult:
    success: bool
    data: Any = None
    error: str | None = None

    def as_text(self) -> str:
        """Text representation inserted back into the LLM conversation context."""
        if not self.success:
            return f"ERROR: {self.error}"
        if isinstance(self.data, str):
            return self.data
        return json.dumps(self.data, ensure_ascii=False, default=str)


class Tool(ABC):
    """Contract every tool must satisfy — whether local or MCP-backed."""

    name: str
    description: str
    parameters_schema: dict[str, Any]

    @abstractmethod
    async def execute(self, **kwargs: Any) -> ToolResult:
        raise NotImplementedError

    def to_schema(self) -> ToolSchema:
        return ToolSchema(
            name=self.name,
            description=self.description,
            parameters=self.parameters_schema,
        )
