from __future__ import annotations

from typing import Any

from anthropic import AsyncAnthropic

from agent_core.llm.base import (
    LLMProvider,
    LLMResponse,
    Message,
    Role,
    ToolCall,
    ToolSchema,
)


class AnthropicProvider(LLMProvider):
    """Provider backed by the Anthropic Messages API.

    The Anthropic format differs from OpenAI in two main respects:
    - `system` is a separate parameter, not a message inside the `messages` list,
    - a tool result is a `user`-role message containing a `tool_result` block
      (not a separate `tool` role), and a tool invocation is a `tool_use`
      block inside an `assistant` message.
    All of that conversion is contained here — the rest of the agent is
    unaware of it.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "claude-sonnet-4-6",
    ) -> None:
        self._client = AsyncAnthropic(api_key=api_key)
        self._model = model

    async def complete(
        self,
        messages: list[Message],
        tools: list[ToolSchema] | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        system, anth_messages = _split_system(messages)
        anth_tools = [_to_anthropic_tool(t) for t in tools] if tools else []
        max_tokens = kwargs.pop("max_tokens", 1024)

        response = await self._client.messages.create(
            model=self._model,
            system=system,
            messages=anth_messages,
            tools=anth_tools,
            max_tokens=max_tokens,
            **kwargs,
        )

        content_text: str | None = None
        tool_calls: list[ToolCall] = []
        for block in response.content:
            if block.type == "text":
                content_text = (content_text or "") + block.text
            elif block.type == "tool_use":
                tool_calls.append(
                    ToolCall(id=block.id, name=block.name, arguments=block.input)
                )

        return LLMResponse(
            content=content_text,
            tool_calls=tool_calls,
            raw=response,
            finish_reason=response.stop_reason,
        )


def _split_system(messages: list[Message]) -> tuple[str | None, list[dict]]:
    system_parts = [m.content for m in messages if m.role == Role.SYSTEM and m.content]
    system = "\n".join(system_parts) if system_parts else None

    anth_messages: list[dict] = []
    for m in messages:
        if m.role == Role.SYSTEM:
            continue

        if m.role == Role.USER:
            anth_messages.append({"role": "user", "content": m.content or ""})

        elif m.role == Role.ASSISTANT:
            content: list[dict] = []
            if m.content:
                content.append({"type": "text", "text": m.content})
            for tc in m.tool_calls:
                content.append(
                    {"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments}
                )
            anth_messages.append({"role": "assistant", "content": content or ""})

        elif m.role == Role.TOOL:
            anth_messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": m.tool_call_id,
                            "content": m.content or "",
                        }
                    ],
                }
            )

    return system, anth_messages


def _to_anthropic_tool(t: ToolSchema) -> dict:
    return {"name": t.name, "description": t.description, "input_schema": t.parameters}
