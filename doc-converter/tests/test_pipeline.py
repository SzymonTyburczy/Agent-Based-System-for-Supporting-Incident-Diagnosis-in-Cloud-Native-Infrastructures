"""Tests for the parts that must not need a 1.3 GB dependency tree loaded."""

from __future__ import annotations

import pytest

from doc_converter.pipeline import (
    FileTooLargeError,
    UnsupportedFileError,
    validate_upload,
)

PDF = b"%PDF-1.4\nrest of the document"


def test_accepts_a_pdf_by_its_magic_bytes():
    validate_upload("runbook.pdf", PDF, max_bytes=1024)


def test_rejects_a_file_over_the_limit():
    with pytest.raises(FileTooLargeError) as exc:
        validate_upload("big.pdf", PDF + b"x" * 2048, max_bytes=1024)

    # The message carries both numbers, so the user knows by how much.
    assert "MB" in str(exc.value)


def test_rejects_an_empty_upload():
    with pytest.raises(UnsupportedFileError):
        validate_upload("empty.pdf", b"", max_bytes=1024)


def test_rejects_a_non_pdf_whatever_the_extension_claims():
    # A .pdf extension on a ZIP: the extension is not evidence, the header is.
    with pytest.raises(UnsupportedFileError):
        validate_upload("actually-a-zip.pdf", b"PK\x03\x04payload", max_bytes=1024)


@pytest.mark.parametrize("name", ["runbook.md", "notes.markdown", "readme.mdx", "log.txt"])
def test_markdown_and_text_are_told_to_use_the_passthrough(name):
    # These must never reach Docling: it would re-parse and re-render a file
    # that is already valid Markdown, reflowing lists and renumbering ordinals.
    with pytest.raises(UnsupportedFileError) as exc:
        validate_upload(name, b"# Runbook\n\nsome text", max_bytes=1024)

    assert "no conversion" in str(exc.value)


def test_size_is_checked_before_the_format():
    # An oversized non-PDF should report the size problem, since that is the
    # one the user can act on without guessing.
    with pytest.raises(FileTooLargeError):
        validate_upload("huge.bin", b"not a pdf" + b"x" * 4096, max_bytes=1024)
