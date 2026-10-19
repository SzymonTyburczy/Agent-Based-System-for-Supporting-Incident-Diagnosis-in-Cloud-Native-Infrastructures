from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="IDAR_",
        env_file=".env",
        env_file_encoding="utf-8",
        # A .env copied from an older .env.example still sets
        # IDAR_EMBEDDING_PROVIDER, which the API key below replaced.
        extra="ignore",
    )

    # Ollama, used when no embedding API key is set.
    embedding_model: str = "qwen3-embedding:0.6b"
    ollama_url: str = "http://localhost:11434"
    # Setting the key switches embeddings to an OpenAI-compatible API (OpenAI by
    # default). The model gets its own collection, so switching either way shows
    # the documents ingested with that model, and only those.
    embedding_api_key: str = ""
    embedding_api_url: str = "https://api.openai.com/v1"
    embedding_api_model: str = "text-embedding-3-small"
    qdrant_url: str = "http://localhost:6333"
    collection_alias: str = "kb_active"
    # The instruction is in English whatever the language of the query, as the
    # Qwen3-Embedding authors recommend. Only the Ollama model gets it: API models
    # such as text-embedding-3 take no instruction.
    query_instruction: str = (
        "Given a technical question about cloud-native infrastructure incidents, "
        "retrieve relevant documentation passages that help diagnose or resolve the issue"
    )
    # Validated: a zero budget sends the chunker's sentence splitter into an
    # endless loop, and a negative overlap makes it skip text.
    chunk_max_tokens: int = Field(600, gt=0)
    chunk_overlap_tokens: int = Field(80, ge=0)
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
