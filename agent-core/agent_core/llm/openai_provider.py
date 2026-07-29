from __future__ import annotations

import json
from typing import Any

from openai import AsyncOpenAI

from agent_core.llm.base import (
    LLMProvider,
    LLMResponse,
    Message,
    Role,
    ToolCall,
    ToolSchema,
)


class OpenAIProvider(LLMProvider):
    """Provider backed by the OpenAI Chat Completions API.

    Also serves as the base class for OllamaProvider — Ollama exposes an
    OpenAI-compatible endpoint (/v1/chat/completions), so overriding
    `base_url` is enough to get a local provider without extra code.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "gpt-4.1",
        base_url: str | None = None,
    ) -> None:
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        self._model = model

    async def complete(
        self,
        messages: list[Message],
        tools: list[ToolSchema] | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        oai_messages = [_to_openai_message(m) for m in messages]
        oai_tools = [_to_openai_tool(t) for t in tools] if tools else None

        response = await self._client.chat.completions.create(
            model=self._model,
            messages=oai_messages,
            tools=oai_tools,
            **kwargs,
        )

        choice = response.choices[0]
        tool_calls = [
            ToolCall(
                id=tc.id,
                name=tc.function.name,
                arguments=json.loads(tc.function.arguments or "{}"),
            )
            for tc in (choice.message.tool_calls or [])
        ]
        return LLMResponse(
            content=choice.message.content,
            tool_calls=tool_calls,
            raw=response,
            finish_reason=choice.finish_reason,
        )


def _to_openai_message(m: Message) -> dict:
    if m.role == Role.TOOL:
        return {
            "role": "tool",
            "tool_call_id": m.tool_call_id,
            "content": m.content or "",
        }

    msg: dict[str, Any] = {"role": m.role.value, "content": m.content}
    if m.tool_calls:
        msg["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
            }
            for tc in m.tool_calls
        ]
    return msg


def _to_openai_tool(t: ToolSchema) -> dict:
    return {
        "type": "function",
        "function": {
            "name": t.name,
            "description": t.description,
            "parameters": t.parameters,
        },
    }
