from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="IDAR_",
        env_file=".env",
        env_file_encoding="utf-8",
    )

    embedding_provider: Literal["ollama"] = "ollama"
    embedding_model: str = "qwen3-embedding:0.6b"
    ollama_url: str = "http://localhost:11434"
    qdrant_url: str = "http://localhost:6333"
    collection_alias: str = "kb_active"
    # The instruction is in English whatever the language of the query, as the
    # Qwen3-Embedding authors recommend.
    query_instruction: str = (
        "Given a technical question about cloud-native infrastructure incidents, "
        "retrieve relevant documentation passages that help diagnose or resolve the issue"
    )
    chunk_max_tokens: int = 600
    chunk_overlap_tokens: int = 80
    breadcrumbs: bool = True

    # Origins allowed by CORS, comma-separated: the panel from Vite (5173) and the
    # panel from the Nginx container (3000). Empty = any origin, for a developer
    # machine only (same semantics as the agent's CLIENT_ALLOWED_ORIGINS).
    cors_origins: str = "http://localhost:5173,http://localhost:3000"
    # Optional bearer token for /api/documents and /api/search; empty = no
    # authentication. /healthz and /api/health are always open (probes).
    api_token: str = ""
    # Containers start in parallel, so Ollama and Qdrant may come up a moment after
    # us. Instead of a crash loop, wait retries * retry_seconds for them.
    startup_retries: int = 30
    startup_retry_seconds: float = 2.0

    def cors_origin_list(self) -> list[str]:
        if not self.cors_origins.strip():
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]
