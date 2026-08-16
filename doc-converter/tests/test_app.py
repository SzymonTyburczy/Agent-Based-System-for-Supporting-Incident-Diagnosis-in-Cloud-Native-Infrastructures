"""HTTP behaviour, against a fake pipeline so no models are loaded."""

from __future__ import annotations

import io

from doc_converter.app import create_app
from doc_converter.config import Settings
from doc_converter.pipeline import ConversionError, ConversionResult

PDF = b"%PDF-1.4\nrest of the document"


class FakePipeline:
    def __init__(self, error: Exception | None = None):
        self.error = error
        self.calls: list[str] = []

    def convert(self, filename: str, data: bytes) -> ConversionResult:
        self.calls.append(filename)
        if self.error:
            raise self.error
        return ConversionResult(markdown="# Runbook\n\nBody.", pages=3, duration_ms=1234)


def client(settings: Settings | None = None, pipeline: FakePipeline | None = None):
    return create_app(settings or Settings(_env_file=None), pipeline or FakePipeline()).test_client()


def post(test_client, data: bytes = PDF, name: str = "runbook.pdf", headers=None):
    return test_client.post(
        "/convert",
        data={"file": (io.BytesIO(data), name)},
        content_type="multipart/form-data",
        headers=headers or {},
    )


def test_healthz():
    assert client().get("/healthz").json["status"] == "ok"


def test_converts_a_pdf():
    response = post(client())

    assert response.status_code == 200
    assert response.json == {
        "markdown": "# Runbook\n\nBody.",
        "pages": 3,
        "engine": "docling",
        "duration_ms": 1234,
    }


def test_missing_file_field_is_400():
    assert client().post("/convert", data={}, content_type="multipart/form-data").status_code == 400


def test_a_non_pdf_is_415_and_never_reaches_the_pipeline():
    pipeline = FakePipeline()

    response = post(client(pipeline=pipeline), data=b"PK\x03\x04zip", name="archive.pdf")

    assert response.status_code == 415
    assert pipeline.calls == []


def test_an_oversized_file_is_413():
    response = post(client(Settings(_env_file=None, max_upload_bytes=64)), data=PDF + b"x" * 512)

    assert response.status_code == 413


def test_an_unusable_document_is_422_not_500():
    response = post(client(pipeline=FakePipeline(ConversionError("Almost no text."))))

    assert response.status_code == 422
    assert "Almost no text." in response.json["error"]


def test_the_token_is_enforced_only_when_configured():
    guarded = Settings(_env_file=None, api_token="s3cret")

    assert post(client(guarded)).status_code == 401
    assert post(client(guarded), headers={"Authorization": "Bearer nope"}).status_code == 401
    assert post(client(guarded), headers={"Authorization": "Bearer s3cret"}).status_code == 200
    # Empty token disables the check, matching agent-core's CLIENT_API_TOKEN.
    assert post(client(Settings(_env_file=None, api_token=""))).status_code == 200


def test_cors_answers_only_the_configured_origin():
    app = client(Settings(_env_file=None, allowed_origins="http://localhost:5173"))

    allowed = post(app, headers={"Origin": "http://localhost:5173"})
    denied = post(app, headers={"Origin": "http://evil.example"})

    assert allowed.headers["Access-Control-Allow-Origin"] == "http://localhost:5173"
    assert "Access-Control-Allow-Origin" not in denied.headers
