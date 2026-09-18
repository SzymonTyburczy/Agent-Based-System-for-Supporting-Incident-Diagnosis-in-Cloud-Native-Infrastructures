"""Upload validation and the VLM header rule. Neither loads Docling."""

from __future__ import annotations

import pytest

from doc_converter.config import Settings
from doc_converter.pipeline import UnsupportedFileError, validate_upload, vlm_headers

PDF = b"%PDF-1.4\nrest of the document"


def test_accepts_a_pdf_by_its_header():
    validate_upload("runbook.pdf", PDF)


def test_rejects_a_non_pdf_whatever_the_extension_claims():
    # A ZIP named .pdf: the extension is not evidence, the header is.
    with pytest.raises(UnsupportedFileError):
        validate_upload("actually-a-zip.pdf", b"PK\x03\x04payload")


@pytest.mark.parametrize("name", ["runbook.md", "notes.markdown", "log.txt"])
def test_markdown_and_text_are_sent_back_to_the_passthrough(name):
    # These must never reach Docling: it would re-render a file that is
    # already valid Markdown.
    with pytest.raises(UnsupportedFileError, match="no conversion"):
        validate_upload(name, b"# Runbook")


def test_a_key_becomes_a_bearer_header_and_no_key_becomes_nothing():
    assert vlm_headers("sk-test") == {"Authorization": "Bearer sk-test"}
    # Not an empty `Bearer `, which some gateways reject — and the default
    # local-model path must work with no configuration.
    assert vlm_headers("") == {}


def test_the_expensive_options_are_off_by_default():
    settings = Settings(_env_file=None)

    assert settings.enable_picture_description is False  # no model, no key
    assert settings.enable_ocr is False  # +62 MB
    assert settings.enable_code_enrichment is False  # +611 MB, ~150x slower
