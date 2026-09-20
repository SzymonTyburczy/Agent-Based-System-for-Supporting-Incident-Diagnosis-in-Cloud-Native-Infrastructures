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
    # Instrukcja po angielsku niezależnie od języka zapytania — zalecenie autorów
    # Qwen3-Embedding.
    query_instruction: str = (
        "Given a technical question about cloud-native infrastructure incidents, "
        "retrieve relevant documentation passages that help diagnose or resolve the issue"
    )
    chunk_max_tokens: int = 600
    chunk_overlap_tokens: int = 80
    breadcrumbs: bool = True

    # Originy dopuszczone przez CORS, po przecinku: panel z Vite (5173) i panel
    # z kontenera Nginx (3000). Pusta wartość = dowolny origin — wyłącznie na
    # maszynie deweloperskiej (te same semantyki co CLIENT_ALLOWED_ORIGINS agenta).
    cors_origins: str = "http://localhost:5173,http://localhost:3000"
    # Opcjonalny token Bearer dla /api/documents i /api/search; pusty = brak
    # uwierzytelniania. /healthz i /api/health są zawsze otwarte (sondy).
    api_token: str = ""
    # Kontenery startują równolegle — Ollama i Qdrant mogą wstać chwilę po nas.
    # Zamiast pętli crashy czekamy retries * retry_seconds na zależności.
    startup_retries: int = 30
    startup_retry_seconds: float = 2.0

    def cors_origin_list(self) -> list[str]:
        if not self.cors_origins.strip():
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]
