"""Flask app: one conversion endpoint and a health check."""

from __future__ import annotations

import logging

from flask import Flask, jsonify, request
from flask_cors import CORS

from doc_converter.config import Settings
from doc_converter.pipeline import (
    ConversionError,
    ConversionPipeline,
    UnsupportedFileError,
    validate_upload,
)

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None, pipeline=None) -> Flask:
    """`pipeline` is injectable so the tests run without loading Docling."""
    settings = settings or Settings()
    app = Flask(__name__)
    # The single upload-size guard: Werkzeug rejects an oversized body before the
    # view runs. The slop covers the multipart envelope (boundary and
    # Content-Disposition headers), so a file of exactly max_upload_bytes — which
    # the browser's own check accepts — is not rejected here for being 200 bytes
    # bigger on the wire than on disk.
    app.config["MAX_CONTENT_LENGTH"] = settings.max_upload_bytes + 8192

    # /healthz is included because the browser reads it too: the panel shows
    # whether this service has a model configured, and a cross-origin fetch
    # without CORS headers is invisible to it.
    CORS(
        app,
        resources={r"/convert": {"origins": settings.origins()}, r"/healthz": {"origins": settings.origins()}},
        methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    if pipeline is None:
        pipeline = ConversionPipeline(settings)
        pipeline.warm_up()

    @app.get("/healthz")
    def healthz():
        return jsonify(
            status="ok",
            engine="docling",
            ocr=settings.enable_ocr,
            figure_descriptions=settings.enable_picture_description,
        )

    @app.post("/convert")
    def convert():
        if settings.api_token and request.headers.get("Authorization") != f"Bearer {settings.api_token}":
            return jsonify(error="Invalid or missing Authorization header."), 401

        upload = request.files.get("file")
        if upload is None:
            return jsonify(error="Send the document as multipart/form-data under `file`."), 400

        data = upload.read()
        filename = upload.filename or "document.pdf"

        try:
            validate_upload(filename, data)
        except UnsupportedFileError as exc:
            return jsonify(error=str(exc)), 415

        try:
            result = pipeline.convert(filename, data)
        except ConversionError as exc:
            # 422: the request was fine, the document was not usable.
            return jsonify(error=str(exc)), 422

        logger.info("Converted %s: %d pages in %d ms", filename, result.pages, result.duration_ms)
        return jsonify(
            markdown=result.markdown,
            pages=result.pages,
            engine="docling",
            duration_ms=result.duration_ms,
        )

    @app.errorhandler(413)
    def too_large(_error):
        """Werkzeug aborts an oversized upload during form parsing, before the
        view runs, so the message has to be produced here."""
        return jsonify(error=f"The file is over the {settings.max_upload_bytes // 1024 // 1024} MB limit."), 413

    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = Settings()
    logger.info("Loading Docling models — the first start takes 60-110s…")
    app = create_app(settings)
    logger.info("Ready on %s:%d", settings.host, settings.port)
    # One conversion at a time: Docling peaks around 3.4 GB RSS on an 8-page
    # document, so concurrent requests would multiply that.
    app.run(host=settings.host, port=settings.port, threaded=False)


if __name__ == "__main__":
    main()
