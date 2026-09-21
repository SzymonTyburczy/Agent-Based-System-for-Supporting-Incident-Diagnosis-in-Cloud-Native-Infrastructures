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
