"""Central configuration, mirroring agent-core's pydantic-settings idiom so
the two services are configured the same way.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    host: str = "0.0.0.0"
    # 8080/8081/8000/8090/9090/9093 are taken by the observability stack and
    # agent-core, 5173 by the Vite dev server.
    port: int = 5001

    # Mirrors the client's own MAX_FILE_SIZE_BYTES (converter.ts) so a file
    # the browser accepts is never rejected here for a different reason.
    max_upload_bytes: int = 15 * 1024 * 1024

    # Bearer token the client must send. Empty = no auth check, matching
    # agent-core's CLIENT_API_TOKEN behaviour.
    api_token: str = ""

    # Comma-separated CORS allowlist. Empty = allow any origin (dev default).
    allowed_origins: str = "http://localhost:5173"

    # Where Docling's model weights live. Set this (and pre-fetch with
    # scripts/prefetch_models.py) to make the service work with no network at
    # all; leaving it empty lets Docling download to its own cache on first use.
    models_dir: str = ""

    # OCR costs ~62MB of RapidOCR weights plus real time per page, and only
    # pays off for scanned documents. Off by default — turn it on if scans
    # are in scope.
    enable_ocr: bool = False

    # Restores line breaks and indentation inside code/YAML blocks, but pulls
    # the 611MB CodeFormulaV2 model and costs ~150x the conversion time
    # (measured: 0.5s -> 74.7s on a one-page runbook). Off by default; the
    # supported way to get faithful YAML is to submit it as Markdown, which
    # the client's passthrough branch already handles.
    enable_code_enrichment: bool = False

    # Hard ceiling per document, so one pathological PDF cannot pin the
    # single worker forever.
    conversion_timeout_seconds: int = 120

    def origins(self) -> list[str] | str:
        """CORS origins for flask-cors: a list, or "*" when unrestricted."""
        origins = [item.strip() for item in self.allowed_origins.split(",") if item.strip()]
        return origins or "*"

    def artifacts_path(self) -> Path | None:
        return Path(self.models_dir).expanduser() if self.models_dir else None
