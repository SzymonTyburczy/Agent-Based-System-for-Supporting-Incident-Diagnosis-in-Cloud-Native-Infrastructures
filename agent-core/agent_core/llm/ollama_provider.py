from __future__ import annotations

from agent_core.llm.openai_provider import OpenAIProvider


class OllamaProvider(OpenAIProvider):
    """Local provider backed by Ollama.

    Ollama exposes an OpenAI-compatible Chat Completions endpoint
    (`/v1/chat/completions`), so instead of writing a separate client, this
    simply subclasses `OpenAIProvider` and overrides `base_url`. This is a
    concrete example of "swapping the provider" being little more than a
    configuration change, given a well-designed abstraction.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "llama3.1",
    ) -> None:
        super().__init__(
            api_key="ollama",  # Ollama does not validate the key, but the client requires one
            model=model,
            base_url=f"{base_url.rstrip('/')}/v1",
        )
