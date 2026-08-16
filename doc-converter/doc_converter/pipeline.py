"""The Docling wrapper: PDF bytes in, Markdown out.

Split so the parts worth testing do not need Docling loaded:
  - `validate_upload` — pure, no I/O, no models;
  - `ConversionPipeline` — holds the one expensive `DocumentConverter` and is
    the only place that imports Docling.

Docling runs entirely locally: its models are small vision models for page
layout and table structure (not LLMs), so no API key and no network call is
involved in a conversion. See README for the weights and their sizes.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

PDF_MAGIC = b"%PDF-"

# Below this, treat the conversion as failed rather than returning an
# apparently-successful empty document. An image-only PDF with OCR disabled
# extracts nothing, and silently storing that in the knowledge base is worse
# than an error the user can act on.
MIN_USEFUL_CHARS = 50


class ConversionError(Exception):
    """Raised when a document cannot be turned into useful Markdown."""


class UnsupportedFileError(Exception):
    """Raised when the upload is not a PDF."""


class FileTooLargeError(Exception):
    """Raised when the upload exceeds `max_upload_bytes`."""


@dataclass(frozen=True)
class ConversionResult:
    markdown: str
    pages: int
    duration_ms: int


def validate_upload(filename: str, data: bytes, max_bytes: int) -> None:
    """Checks an upload before any model is touched.

    Sniffs the PDF magic bytes rather than trusting the extension or the
    browser-supplied content type: this service accepts exactly one format,
    and the cheapest way to enforce that is to look at the file.
    """
    if not data:
        raise UnsupportedFileError("The uploaded file is empty.")

    if len(data) > max_bytes:
        raise FileTooLargeError(
            f"The file is {len(data) / 1024 / 1024:.1f} MB, "
            f"over the {max_bytes / 1024 / 1024:.0f} MB limit."
        )

    if not data.startswith(PDF_MAGIC):
        suffix = Path(filename).suffix.lower()
        if suffix in {".md", ".markdown", ".mdx", ".txt"}:
            # The client already passes these through untouched, and it must
            # keep doing so: Docling would re-parse and re-render them,
            # reflowing lists and renumbering ordinals in a file that was
            # already valid Markdown.
            raise UnsupportedFileError(
                f"{suffix} files need no conversion — send them through unchanged."
            )
        raise UnsupportedFileError("Only PDF files are converted here.")


class ConversionPipeline:
    """Owns the one `DocumentConverter` instance.

    Building it loads ~570MB of model weights and takes 60-110s, so it is
    built once and reused. `warm_up()` lets the process pay that at startup
    instead of making the first user wait for it.
    """

    def __init__(
        self,
        *,
        artifacts_path: Path | None = None,
        enable_ocr: bool = False,
        enable_code_enrichment: bool = False,
        timeout_seconds: int = 120,
    ) -> None:
        # Imported lazily so `validate_upload` and the Flask routes can be
        # tested without a 1.3GB dependency tree.
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption

        options = PdfPipelineOptions(
            do_ocr=enable_ocr,
            do_table_structure=True,
            do_code_enrichment=enable_code_enrichment,
            artifacts_path=artifacts_path,
            document_timeout=timeout_seconds,
        )

        self._converter = DocumentConverter(
            # Restricting the format set is a security measure, not tidiness:
            # it removes the HTML, LaTeX and XML parsing paths this service
            # never needs, along with the CVEs that have historically lived
            # in them.
            allowed_formats=[InputFormat.PDF],
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
        )

    def convert(self, filename: str, data: bytes) -> ConversionResult:
        from docling.datamodel.base_models import DocumentStream
        import io

        started = time.monotonic()
        try:
            result = self._converter.convert(
                DocumentStream(name=filename, stream=io.BytesIO(data))
            )
        except Exception as exc:  # noqa: BLE001 - Docling raises a wide range
            logger.exception("Docling failed on %s", filename)
            raise ConversionError(f"The document could not be parsed: {exc}") from exc

        markdown = result.document.export_to_markdown(
            # Default True would emit `container\_memory\_working\_set\_bytes`
            # for every metric name in the corpus.
            escape_underscores=False,
            # Default is "<!-- image -->", which would put a comment token in
            # the knowledge base for every figure.
            image_placeholder="",
        ).strip()

        if len(markdown) < MIN_USEFUL_CHARS:
            raise ConversionError(
                "Almost no text could be extracted. If this is a scanned document, "
                "enable OCR (ENABLE_OCR=true) and try again."
            )

        return ConversionResult(
            markdown=markdown,
            pages=len(result.document.pages),
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    def warm_up(self) -> None:
        """Forces model load with a tiny synthetic PDF, so the cost lands at
        startup rather than on the first upload."""
        try:
            self.convert("warmup.pdf", _MINIMAL_PDF)
        except ConversionError:
            # Expected: the warm-up document has almost no text. The models
            # are loaded by then, which is the whole point.
            pass
        except Exception:  # noqa: BLE001
            logger.warning("Warm-up conversion failed; first request will be slow.", exc_info=True)


# The smallest structurally valid PDF that still exercises the parse path.
_MINIMAL_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
    b"trailer<</Root 1 0 R>>\n"
)
