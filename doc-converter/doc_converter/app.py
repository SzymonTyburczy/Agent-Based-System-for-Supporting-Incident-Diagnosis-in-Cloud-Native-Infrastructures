"""Flask app: one conversion endpoint and a health check.

Deliberately small. The service exists to move document conversion off the
browser (where the API key was compiled into the public bundle) and onto a
local process — not to grow into a second backend.
"""

from __future__ import annotations

import logging

from flask import Flask, jsonify, request
from flask_cors import CORS

from doc_converter.config import Settings
from doc_converter.pipeline import (
    ConversionError,
    ConversionPipeline,
    FileTooLargeError,
    UnsupportedFileError,
    validate_upload,
)

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None, pipeline: ConversionPipeline | None = None) -> Flask:
    """Both arguments are injectable so the tests can run without Docling."""
    settings = settings or Settings()
    app = Flask(__name__)
    app.config["SETTINGS"] = settings
    # Flask would otherwise buffer the whole body before our size check runs.
    app.config["MAX_CONTENT_LENGTH"] = settings.max_upload_bytes

    CORS(
        app,
        resources={r"/convert": {"origins": settings.origins()}},
        methods=["POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    if pipeline is None:
        pipeline = ConversionPipeline(
            artifacts_path=settings.artifacts_path(),
            enable_ocr=settings.enable_ocr,
            enable_code_enrichment=settings.enable_code_enrichment,
            timeout_seconds=settings.conversion_timeout_seconds,
        )
        pipeline.warm_up()

    app.config["PIPELINE"] = pipeline

    @app.get("/healthz")
    def healthz():
        return jsonify(status="ok", engine="docling", ocr=settings.enable_ocr)

    @app.post("/convert")
    def convert():
        if not _authorized(settings, request.headers.get("Authorization")):
            return jsonify(error="Invalid or missing Authorization header."), 401

        upload = request.files.get("file")
        if upload is None:
            return jsonify(error="Send the document as multipart/form-data under `file`."), 400

        data = upload.read()
        filename = upload.filename or "document.pdf"

        try:
            validate_upload(filename, data, settings.max_upload_bytes)
        except FileTooLargeError as exc:
            return jsonify(error=str(exc)), 413
        except UnsupportedFileError as exc:
            return jsonify(error=str(exc)), 415

        try:
            result = pipeline.convert(filename, data)
        except ConversionError as exc:
            # 422: the request was well-formed, the document was not usable.
            return jsonify(error=str(exc)), 422

        logger.info(
            "Converted %s: %d pages, %d chars, %d ms",
            filename,
            result.pages,
            len(result.markdown),
            result.duration_ms,
        )
        return jsonify(
            markdown=result.markdown,
            pages=result.pages,
            engine="docling",
            duration_ms=result.duration_ms,
        )

    @app.errorhandler(413)
    def too_large(_error):
        """Flask rejects an oversized body before the view runs, so the
        friendly message from `validate_upload` would never be reached."""
        limit_mb = settings.max_upload_bytes / 1024 / 1024
        return jsonify(error=f"The file is over the {limit_mb:.0f} MB limit."), 413

    return app


def _authorized(settings: Settings, header: str | None) -> bool:
    if not settings.api_token:
        return True
    return header == f"Bearer {settings.api_token}"


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = Settings()
    logger.info("Loading Docling models — first start takes 60-110s…")
    app = create_app(settings)
    logger.info("Converter ready on %s:%d", settings.host, settings.port)
    # threaded=False: one conversion at a time. Docling peaks at ~3.4GB RSS on
    # an 8-page document, so concurrent requests would multiply that on a
    # laptop already running the observability stack.
    app.run(host=settings.host, port=settings.port, threaded=False)


if __name__ == "__main__":
    main()
