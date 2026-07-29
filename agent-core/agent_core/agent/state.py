from __future__ import annotations

from dataclasses import dataclass, field

from agent_core.llm.base import Message, Role, ToolCall


@dataclass
class ConversationState:
    """Message history for a single conversation with the agent.

    Currently kept in process memory — sufficient for this skeleton. If the
    Slack integration requires state to persist across HTTP invocations, this
    object can later be serialized to Redis/a database without changing the
    rest of the agent.
    """

    messages: list[Message] = field(default_factory=list)

    def add_system(self, content: str) -> None:
        self.messages.append(Message(role=Role.SYSTEM, content=content))

    def add_user(self, content: str) -> None:
        self.messages.append(Message(role=Role.USER, content=content))

    def add_assistant(
        self, content: str | None = None, tool_calls: list[ToolCall] | None = None
    ) -> None:
        self.messages.append(
            Message(role=Role.ASSISTANT, content=content, tool_calls=tool_calls or [])
        )

    def add_tool_result(self, tool_call_id: str, name: str, content: str) -> None:
        self.messages.append(
            Message(role=Role.TOOL, content=content, tool_call_id=tool_call_id, name=name)
        )

    def has_system_prompt(self) -> bool:
        return any(m.role == Role.SYSTEM for m in self.messages)
