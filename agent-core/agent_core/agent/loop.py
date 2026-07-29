"""Agent decision loop (ReAct pattern: reason -> act -> observe -> ...).

This class has no knowledge of whether the tools in `ToolRegistry` come from
a CLI or from MCP, nor of which specific LLM backend sits behind
`LLMProvider` — that is precisely the "skeleton where sources are easy to
swap" required by the task.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from agent_core.agent.state import ConversationState
from agent_core.llm.base import LLMProvider
from agent_core.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = (
    "You are an agent that supports incident diagnosis in cloud-native "
    "infrastructure. You have access to diagnostic tools (telemetry, CLI). "
    "Your role is decision support only — never perform actions that modify "
    "the infrastructure. If you need data, call the relevant tool instead of "
    "guessing."
)


@dataclass
class AgentConfig:
    max_iterations: int = 8
    system_prompt: str = DEFAULT_SYSTEM_PROMPT


class AgentLoop:
    def __init__(
        self,
        provider: LLMProvider,
        tools: ToolRegistry,
        config: AgentConfig | None = None,
    ) -> None:
        self.provider = provider
        self.tools = tools
        self.config = config or AgentConfig()

    async def run(self, user_message: str, state: ConversationState | None = None) -> ConversationState:
        state = state or ConversationState()
        if not state.has_system_prompt():
            state.add_system(self.config.system_prompt)
        state.add_user(user_message)

        tool_schemas = self.tools.schemas()
        logger.info(
            "Starting agent run: max_iterations=%d, tools_available=%d",
            self.config.max_iterations,
            len(tool_schemas),
        )
        started = time.monotonic()

        for iteration in range(self.config.max_iterations):
            try:
                response = await self.provider.complete(state.messages, tools=tool_schemas)
            except Exception as exc:
                # A provider error (rate limit, network timeout, ...) should
                # not crash the whole agent process with a raw traceback —
                # especially once this is meant to answer on Slack.
                logger.error("LLM provider raised an error at iteration=%s: %s", iteration, exc)
                state.add_assistant(
                    "Could not complete the diagnosis — a communication error occurred with "
                    f"the LLM ({exc.__class__.__name__}). Please try again shortly."
                )
                return state

            state.add_assistant(response.content, response.tool_calls)

            if not response.tool_calls:
                # The model answered without calling a tool -> this is the final answer.
                logger.info(
                    "Finished after %d/%d iteration(s) in %.1fs (model produced a final answer).",
                    iteration + 1,
                    self.config.max_iterations,
                    time.monotonic() - started,
                )
                return state

            for call in response.tool_calls:
                logger.info(
                    "iteration=%s tool=%s arguments=%s", iteration, call.name, call.arguments
                )
                call_started = time.monotonic()
                result = await self.tools.call(call.name, call.arguments)
                call_elapsed = time.monotonic() - call_started
                if result.success:
                    logger.info(
                        "iteration=%s tool=%s -> ok (%d chars, %.2fs)",
                        iteration,
                        call.name,
                        len(result.as_text()),
                        call_elapsed,
                    )
                else:
                    logger.warning(
                        "iteration=%s tool=%s -> error (%.2fs): %s",
                        iteration,
                        call.name,
                        call_elapsed,
                        result.error,
                    )
                state.add_tool_result(call.id, call.name, result.as_text())

        # Iteration budget exhausted. The conversation so far may already
        # contain useful findings (e.g. "both checkout pods are healthy",
        # ruling out a whole class of causes) — discarding all of that in
        # favour of a generic "I gave up" message would throw away real
        # signal. Ask the model for a best-effort summary instead, with no
        # tools offered so it cannot keep stalling on further tool calls.
        logger.warning(
            "Iteration budget exhausted (%d iterations, %.1fs) — requesting a wrap-up summary.",
            self.config.max_iterations,
            time.monotonic() - started,
        )
        state.add_user(
            "You have reached the tool-call budget for this investigation. "
            "Do not call any more tools. Based only on the information "
            "already gathered above, give your best-effort diagnosis: "
            "probable root cause and suggested next steps, and note "
            "explicitly what remains uncertain or unverified."
        )
        try:
            wrapup = await self.provider.complete(state.messages, tools=None)
        except Exception as exc:
            logger.error("Wrap-up call after the iteration limit failed: %s", exc)
            wrapup = None

        if wrapup is not None and wrapup.content:
            state.add_assistant(wrapup.content)
        else:
            state.add_assistant(
                "The agent reached its iteration limit without producing a final answer. "
                "Consider raising AgentConfig.max_iterations or narrowing the question."
            )
        return state
