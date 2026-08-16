"""HTTP-level tests, run against a fake pipeline so no models are loaded."""

from __future__ import annotations

import io

import pytest

from doc_converter.app import create_app
from doc_converter.config import Settings
from doc_converter.pipeline import ConversionError, ConversionResult

PDF = b"%PDF-1.4\nrest of the document"


class FakePipeline:
    """Stands in for ConversionPipeline: same two methods, no Docling."""

    def __init__(self, *, error: Exception | None = None):
        self.error = error
        self.calls: list[str] = []

    def convert(self, filename: str, data: bytes) -> ConversionResult:
        self.calls.append(filename)
        if self.error:
            raise self.error
        return ConversionResult(markdown="# Runbook\n\nBody.", pages=3, duration_ms=1234)

    def warm_up(self) -> None:  # pragma: no cover - never called in tests
        pass


def build(settings: Settings | None = None, pipeline: FakePipeline | None = None):
    settings = settings or Settings(_env_file=None)
    app = create_app(settings, pipeline or FakePipeline())
    return app.test_client()


def upload(client, data: bytes = PDF, name: str = "runbook.pdf", headers=None):
    return client.post(
        "/convert",
        data={"file": (io.BytesIO(data), name)},
        content_type="multipart/form-data",
        headers=headers or {},
    )


def test_healthz_reports_the_engine():
    response = build().get("/healthz")

    assert response.status_code == 200
    assert response.json["status"] == "ok"
    assert response.json["engine"] == "docling"


def test_converts_a_pdf_and_returns_the_markdown():
    response = upload(build())

    assert response.status_code == 200
    assert response.json["markdown"] == "# Runbook\n\nBody."
    assert response.json["pages"] == 3
    assert response.json["duration_ms"] == 1234


def test_missing_file_field_is_a_400():
    response = build().post("/convert", data={}, content_type="multipart/form-data")

    assert response.status_code == 400


def test_a_non_pdf_is_415_and_never_reaches_the_pipeline():
    pipeline = FakePipeline()
    response = upload(build(pipeline=pipeline), data=b"PK\x03\x04zip", name="archive.pdf")

    assert response.status_code == 415
    assert pipeline.calls == []


def test_markdown_upload_is_pointed_back_at_the_passthrough():
    response = upload(build(), data=b"# Already markdown", name="runbook.md")

    assert response.status_code == 415
    assert "no conversion" in response.json["error"]


def test_an_oversized_file_is_413():
    settings = Settings(_env_file=None, max_upload_bytes=64)
    response = upload(build(settings), data=PDF + b"x" * 512)

    assert response.status_code == 413
    assert "limit" in response.json["error"]


def test_an_unusable_document_is_422_not_500():
    pipeline = FakePipeline(error=ConversionError("Almost no text could be extracted."))
    response = upload(build(pipeline=pipeline))

    assert response.status_code == 422
    assert "no text" in response.json["error"]


class TestAuth:
    settings = Settings(_env_file=None, api_token="s3cret")

    def test_rejects_a_request_with_no_token(self):
        assert upload(build(self.settings)).status_code == 401

    def test_rejects_a_wrong_token(self):
        response = upload(build(self.settings), headers={"Authorization": "Bearer nope"})

        assert response.status_code == 401

    def test_accepts_the_configured_token(self):
        response = upload(build(self.settings), headers={"Authorization": "Bearer s3cret"})

        assert response.status_code == 200

    def test_an_empty_token_disables_the_check(self):
        # Matches agent-core's CLIENT_API_TOKEN behaviour, so the two services
        # are configured the same way.
        assert upload(build(Settings(_env_file=None, api_token=""))).status_code == 200


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://evil.example"])
def test_cors_allows_only_the_configured_origin(origin):
    settings = Settings(_env_file=None, allowed_origins="http://localhost:5173")
    response = upload(build(settings), headers={"Origin": origin})

    allowed = response.headers.get("Access-Control-Allow-Origin")
    if origin == "http://localhost:5173":
        assert allowed == origin
    else:
        assert allowed is None
