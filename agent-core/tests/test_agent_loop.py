from __future__ import annotations

import pytest

from agent_core.agent.loop import AgentConfig, AgentLoop
from agent_core.llm.base import (
    LLMProvider,
    LLMResponse,
    Role,
    ToolCall,
)
from agent_core.tools.base import Tool, ToolResult
from agent_core.tools.registry import ToolRegistry


class FakeProvider(LLMProvider):
    """Returns a pre-scripted sequence of responses, one per call."""

    def __init__(self, responses: list[LLMResponse]) -> None:
        self._responses = list(responses)
        self.calls: list[list] = []
        self.tools_per_call: list[object] = []

    async def complete(self, messages, tools=None, **kwargs):
        self.calls.append(list(messages))
        self.tools_per_call.append(tools)
        if not self._responses:
            raise AssertionError("FakeProvider: no more scripted responses left")
        return self._responses.pop(0)


class EchoTool(Tool):
    name = "echo"
    description = "Returns the given text"
    parameters_schema = {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    }

    async def execute(self, text: str) -> ToolResult:
        return ToolResult(success=True, data=text)


@pytest.mark.asyncio
async def test_agent_loop_calls_tool_then_returns_final_answer():
    tool_call = ToolCall(id="call_1", name="echo", arguments={"text": "hello"})
    provider = FakeProvider(
        [
            LLMResponse(content=None, tool_calls=[tool_call]),
            LLMResponse(content="Final answer: hello", tool_calls=[]),
        ]
    )
    registry = ToolRegistry()
    registry.register(EchoTool())

    loop = AgentLoop(provider=provider, tools=registry, config=AgentConfig(max_iterations=4))
    state = await loop.run("say hello")

    assert state.messages[-1].content == "Final answer: hello"
    tool_messages = [m for m in state.messages if m.role == Role.TOOL]
    assert len(tool_messages) == 1
    assert tool_messages[0].content == "hello"
    assert tool_messages[0].tool_call_id == "call_1"
    assert len(provider.calls) == 2  # two loop iterations


@pytest.mark.asyncio
async def test_agent_loop_reports_tool_error_without_crashing():
    tool_call = ToolCall(id="call_1", name="missing_tool", arguments={})
    provider = FakeProvider(
        [
            LLMResponse(content=None, tool_calls=[tool_call]),
            LLMResponse(content="Could not retrieve the data.", tool_calls=[]),
        ]
    )
    registry = ToolRegistry()  # intentionally empty

    loop = AgentLoop(provider=provider, tools=registry)
    state = await loop.run("do something")

    tool_messages = [m for m in state.messages if m.role == Role.TOOL]
    assert tool_messages[0].content.startswith("ERROR:")
    assert state.messages[-1].content == "Could not retrieve the data."


@pytest.mark.asyncio
async def test_agent_loop_asks_for_wrapup_summary_when_iterations_exhausted():
    """When the budget runs out, the loop must not just give up — it should
    make one extra call with no tools offered and use the model's summary
    of what was already gathered as the final answer.
    """
    call = ToolCall(id="x", name="echo", arguments={"text": "loop"})
    provider = FakeProvider(
        [
            LLMResponse(content=None, tool_calls=[call]),
            LLMResponse(content=None, tool_calls=[call]),
            LLMResponse(content=None, tool_calls=[call]),
            LLMResponse(content="Likely cause: X. Unverified: Y.", tool_calls=[]),
        ]
    )
    registry = ToolRegistry()
    registry.register(EchoTool())

    loop = AgentLoop(provider=provider, tools=registry, config=AgentConfig(max_iterations=3))
    state = await loop.run("loop forever")

    assert state.messages[-1].content == "Likely cause: X. Unverified: Y."
    assert len(provider.calls) == 4  # 3 tool-call turns + 1 wrap-up call
    assert not provider.tools_per_call[-1]  # wrap-up call must offer no tools
    assert "reached the tool-call budget" in state.messages[-2].content


@pytest.mark.asyncio
async def test_agent_loop_falls_back_to_generic_message_if_wrapup_also_fails():
    call = ToolCall(id="x", name="echo", arguments={"text": "loop"})

    class FlakyProvider(LLMProvider):
        def __init__(self) -> None:
            self.calls = 0

        async def complete(self, messages, tools=None, **kwargs):
            self.calls += 1
            if tools:  # the regular loop iterations always pass tools
                return LLMResponse(content=None, tool_calls=[call])
            raise RuntimeError("wrap-up call failed too")

    registry = ToolRegistry()
    registry.register(EchoTool())

    loop = AgentLoop(provider=FlakyProvider(), tools=registry, config=AgentConfig(max_iterations=2))
    state = await loop.run("loop forever")

    assert "iteration limit" in state.messages[-1].content


@pytest.mark.asyncio
async def test_agent_loop_survives_provider_error_with_readable_message():
    class ExplodingProvider(LLMProvider):
        async def complete(self, messages, tools=None, **kwargs):
            raise RuntimeError("429 rate limit exceeded")

    registry = ToolRegistry()
    loop = AgentLoop(provider=ExplodingProvider(), tools=registry)

    state = await loop.run("diagnose the incident")

    assert state.messages[-1].role == Role.ASSISTANT
    assert "communication error" in state.messages[-1].content
    # run() must not raise the exception to its caller


@pytest.mark.asyncio
async def test_system_prompt_added_only_once_across_multiple_runs():
    provider = FakeProvider(
        [
            LLMResponse(content="answer 1", tool_calls=[]),
            LLMResponse(content="answer 2", tool_calls=[]),
        ]
    )
    registry = ToolRegistry()
    loop = AgentLoop(provider=provider, tools=registry)

    state = await loop.run("first question")
    state = await loop.run("second question", state=state)

    system_messages = [m for m in state.messages if m.role == Role.SYSTEM]
    assert len(system_messages) == 1
