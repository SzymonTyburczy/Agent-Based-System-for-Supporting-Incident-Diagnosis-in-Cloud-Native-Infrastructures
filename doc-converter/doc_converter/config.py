"""Settings, read from the environment or an optional .env file.

Every value has a working default, so the service runs with no configuration
at all. See README.md for the table.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    host: str = "0.0.0.0"
    # 8000/8080/8081/8090/9090/9093 belong to the observability stack and
    # agent-core, 5173 to the Vite dev server.
    port: int = 5001

    # Mirrors the client's own MAX_FILE_SIZE_BYTES, so a file the browser
    # accepts is never rejected here for a different reason.
    max_upload_bytes: int = 15 * 1024 * 1024

    # Empty = no auth check, matching agent-core's CLIENT_API_TOKEN.
    api_token: str = ""
    allowed_origins: str = "http://localhost:5173"

    # Pre-fetched Docling weights. Empty = let Docling download to its own
    # cache on first use.
    models_dir: str = ""

    enable_ocr: bool = False
    # Restores line breaks inside code blocks, but pulls a 611 MB model and
    # costs ~150x the conversion time. See README.
    enable_code_enrichment: bool = False
    conversion_timeout_seconds: int = 120

    # Optional figure descriptions. The only setting that involves a model
    # outside this machine — and only for pictures, never for layout or
    # tables. The endpoint is OpenAI-compatible, so any provider works.
    enable_picture_description: bool = False
    vlm_api_url: str = "http://localhost:11434/v1/chat/completions"
    vlm_api_key: str = ""
    vlm_model: str = "llava"
    vlm_prompt: str = "Describe this figure in two sentences, for a technical knowledge base."
    vlm_timeout_seconds: float = 60.0

    def origins(self) -> list[str] | str:
        origins = [item.strip() for item in self.allowed_origins.split(",") if item.strip()]
        return origins or "*"

    def artifacts_path(self) -> Path | None:
        return Path(self.models_dir).expanduser() if self.models_dir else None
