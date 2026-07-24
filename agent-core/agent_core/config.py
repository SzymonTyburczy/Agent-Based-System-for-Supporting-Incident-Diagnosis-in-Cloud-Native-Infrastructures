"""Central configuration. Swapping the LLM provider means changing LLM_PROVIDER
in .env, without touching the agent or tool code.
"""

from __future__ import annotations

from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

from agent_core.llm.base import LLMProvider


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    llm_provider: Literal["openai", "anthropic", "ollama"] = "openai"

    openai_api_key: str | None = None
    openai_model: str = "gpt-4.1"

    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-sonnet-4-6"

    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1"

    # Address of the Grafana MCP server exposed by the reference
    # observability infrastructure module
    # (Grafana MCP Server (SSE): http://localhost:8000/sse, --disable-write: true)
    mcp_grafana_url: str = "http://localhost:8000/sse"
    mcp_grafana_tool_prefix: str = "grafana_"

    # The mcp-grafana server can return 60+ tools (on-call scheduling,
    # incidents, plugins, provisioning, snapshots, ...), of which only a
    # fraction is actually relevant for incident diagnosis. Every additional
    # tool adds tokens to EVERY LLM call, so an empty value here means
    # "register everything", but in practice this should always be narrowed
    # down (see .env.example).
    mcp_grafana_tool_allowlist: str = ""

    agent_max_iterations: int = 12

    # How often (seconds) main.py polls the alerting tool for firing alerts
    # when running continuously. See agent_run_once below for the
    # alternative single-shot mode.
    agent_poll_interval_seconds: int = 60

    # False (default): run forever, polling for firing alerts and starting
    # an investigation whenever the firing set changes (see
    # incident.alerts_signature) — this is the intended mode, matching the
    # thesis's "react to monitoring alerts" premise.
    # True: run exactly one investigation and exit — either from whatever
    # is firing right now, or from the static example question if nothing
    # is. Useful for a quick smoke test without waiting for a real alert.
    agent_run_once: bool = False

    # Address the webhook server (webhook_server.py) listens on.
    webhook_host: str = "0.0.0.0"
    webhook_port: int = 8080

    # If set, /alerts/webhook requires "Authorization: Bearer <this value>".
    # Alertmanager's webhook_configs support this natively via
    # http_config.authorization.credentials — see .env.example and README.
    # None/empty = no auth check (fine for local dev, never for anything
    # reachable outside localhost).
    webhook_shared_secret: str | None = None

    # Where finished investigations are saved as JSON files (see
    # agent_core/report.py). Relative paths are resolved against the
    # current working directory the process was started from.
    report_output_dir: str = "./reports"

    # Allowlist of namespaces for the kubectl tools (empty = no restriction)
    kubectl_allowed_namespaces: str = ""

    def kubectl_namespaces(self) -> set[str] | None:
        if not self.kubectl_allowed_namespaces.strip():
            return None
        return {ns.strip() for ns in self.kubectl_allowed_namespaces.split(",") if ns.strip()}

    def mcp_tool_allowlist(self) -> set[str] | None:
        if not self.mcp_grafana_tool_allowlist.strip():
            return None
        return {
            name.strip() for name in self.mcp_grafana_tool_allowlist.split(",") if name.strip()
        }


def build_provider(settings: Settings) -> LLMProvider:
    """Factory that builds the LLM provider based on configuration.

    This is the only place in the codebase that needs to be aware of all
    available providers — the rest of the agent operates on the
    `LLMProvider` abstraction and is completely independent of this choice.
    """
    if settings.llm_provider == "openai":
        from agent_core.llm.openai_provider import OpenAIProvider

        return OpenAIProvider(api_key=settings.openai_api_key, model=settings.openai_model)

    if settings.llm_provider == "anthropic":
        from agent_core.llm.anthropic_provider import AnthropicProvider

        return AnthropicProvider(
            api_key=settings.anthropic_api_key, model=settings.anthropic_model
        )

    if settings.llm_provider == "ollama":
        from agent_core.llm.ollama_provider import OllamaProvider

        return OllamaProvider(base_url=settings.ollama_base_url, model=settings.ollama_model)

    raise ValueError(f"Unknown LLM_PROVIDER: '{settings.llm_provider}'")
