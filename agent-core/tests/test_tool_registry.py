from __future__ import annotations

import pytest

from agent_core.tools.base import Tool, ToolResult
from agent_core.tools.registry import ToolRegistry


class DummyTool(Tool):
    name = "dummy"
    description = "test tool"
    parameters_schema = {
        "type": "object",
        "properties": {"value": {"type": "integer"}},
        "required": ["value"],
    }

    async def execute(self, value: int) -> ToolResult:
        return ToolResult(success=True, data=value * 2)


def test_register_and_list_schemas():
    registry = ToolRegistry()
    registry.register(DummyTool())

    schemas = registry.schemas()

    assert len(schemas) == 1
    assert schemas[0].name == "dummy"
    assert schemas[0].parameters["required"] == ["value"]


def test_duplicate_registration_raises_without_overwrite():
    registry = ToolRegistry()
    registry.register(DummyTool())

    with pytest.raises(ValueError):
        registry.register(DummyTool())


def test_duplicate_registration_allowed_with_overwrite():
    registry = ToolRegistry()
    registry.register(DummyTool())
    registry.register(DummyTool(), overwrite=True)  # should not raise

    assert len(registry) == 1


@pytest.mark.asyncio
async def test_call_unknown_tool_returns_error_result():
    registry = ToolRegistry()

    result = await registry.call("does-not-exist", {})

    assert result.success is False
    assert "Unknown tool" in result.error


@pytest.mark.asyncio
async def test_call_with_wrong_arguments_returns_error_result_not_exception():
    registry = ToolRegistry()
    registry.register(DummyTool())

    result = await registry.call("dummy", {"nonexistent_argument": 1})

    assert result.success is False
    assert result.error is not None


@pytest.mark.asyncio
async def test_call_executes_tool_and_returns_data():
    registry = ToolRegistry()
    registry.register(DummyTool())

    result = await registry.call("dummy", {"value": 21})

    assert result.success is True
    assert result.data == 42
