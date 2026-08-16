"""The Docling wrapper: PDF bytes in, Markdown out.

Docling is imported lazily, inside the methods that need it, so this module
and the Flask routes can be imported and tested without loading a 1.3 GB
dependency tree.
"""

from __future__ import annotations

import io
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from doc_converter.config import Settings

logger = logging.getLogger(__name__)

PDF_MAGIC = b"%PDF-"
PASSTHROUGH_SUFFIXES = {".md", ".markdown", ".mdx", ".txt"}

# Below this, treat the conversion as failed rather than returning an
# apparently-successful empty document: an image-only PDF with OCR off
# extracts nothing, and storing that silently is worse than an error.
MIN_USEFUL_CHARS = 50


class ConversionError(Exception):
    """The document could not be turned into useful Markdown."""


class UnsupportedFileError(Exception):
    """The upload is not a PDF."""


@dataclass(frozen=True)
class ConversionResult:
    markdown: str
    pages: int
    duration_ms: int


def validate_upload(filename: str, data: bytes) -> None:
    """Checks an upload before any model is touched.

    Sniffs the PDF header rather than trusting the extension or the
    browser-supplied content type.
    """
    if not data:
        raise UnsupportedFileError("The uploaded file is empty.")

    if not data.startswith(PDF_MAGIC):
        if Path(filename).suffix.lower() in PASSTHROUGH_SUFFIXES:
            # Docling would re-parse and re-render an already-valid Markdown
            # file, reflowing lists and renumbering ordinals. The client sends
            # these through untouched and must keep doing so.
            raise UnsupportedFileError(
                "Markdown and text files need no conversion — send them through unchanged."
            )
        raise UnsupportedFileError("Only PDF files are converted here.")


def vlm_headers(api_key: str) -> dict[str, str]:
    """An empty key means a local model with no auth, not an error — so no
    header at all, rather than an empty `Bearer `, which some gateways reject.
    """
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


class ConversionPipeline:
    """Owns the one DocumentConverter.

    Building it loads the model weights and takes 60-110 s, so it is built
    once at startup and reused.
    """

    def __init__(self, settings: Settings) -> None:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption

        options = PdfPipelineOptions(
            do_ocr=settings.enable_ocr,
            do_table_structure=True,
            do_code_enrichment=settings.enable_code_enrichment,
            artifacts_path=settings.artifacts_path(),
            document_timeout=settings.conversion_timeout_seconds,
        )

        if settings.enable_picture_description:
            from docling.datamodel.pipeline_options import PictureDescriptionApiOptions

            options.generate_picture_images = True  # required before anything can look at them
            options.do_picture_description = True
            options.enable_remote_services = True  # Docling refuses remote calls without this
            options.picture_description_options = PictureDescriptionApiOptions(
                url=settings.vlm_api_url,
                headers=vlm_headers(settings.vlm_api_key),
                params={"model": settings.vlm_model},
                prompt=settings.vlm_prompt,
                timeout=settings.vlm_timeout_seconds,
            )
            logger.info("Figure descriptions on: %s (%s)", settings.vlm_api_url, settings.vlm_model)

        self._converter = DocumentConverter(
            # Not tidiness: this drops the HTML, LaTeX and XML parsing paths
            # where Docling's CVEs have historically lived.
            allowed_formats=[InputFormat.PDF],
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
        )

    def convert(self, filename: str, data: bytes) -> ConversionResult:
        from docling.datamodel.base_models import ConversionStatus, DocumentStream

        started = time.monotonic()
        try:
            result = self._converter.convert(DocumentStream(name=filename, stream=io.BytesIO(data)))
        except Exception as exc:  # noqa: BLE001 - Docling raises a wide range
            logger.exception("Docling failed on %s", filename)
            raise ConversionError(f"The document could not be parsed: {exc}") from exc

        # Docling does NOT raise when it runs out of the document_timeout budget
        # or a page fails to parse — it stops early and reports PARTIAL_SUCCESS.
        # Returning that as a clean 200 would put a silently truncated runbook
        # into the knowledge base, which is the failure MIN_USEFUL_CHARS exists
        # to prevent.
        if result.status != ConversionStatus.SUCCESS:
            logger.warning("Docling returned %s for %s", result.status, filename)
            raise ConversionError(
                f"The document was only partially converted ({result.status.value}). "
                "It may be too large for the conversion timeout, or partly unreadable."
            )

        markdown = result.document.export_to_markdown(
            # Defaults would emit `container\_memory\_working\_set\_bytes` for
            # every metric name, and an `<!-- image -->` token per figure.
            escape_underscores=False,
            image_placeholder="",
        ).strip()

        if len(markdown) < MIN_USEFUL_CHARS:
            raise ConversionError(
                "Almost no text could be extracted. If this is a scanned document, "
                "set ENABLE_OCR=true and try again."
            )

        return ConversionResult(
            markdown=markdown,
            pages=len(result.document.pages),
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    def warm_up(self) -> None:
        """Loads the models at startup, so the first upload is not the one
        that pays the 60-110 s."""
        try:
            self.convert("warmup.pdf", _MINIMAL_PDF)
        except ConversionError:
            pass  # expected: the warm-up document has no text. Models are loaded by now.
        except Exception:  # noqa: BLE001
            logger.warning("Warm-up failed; the first request will be slow.", exc_info=True)


_MINIMAL_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
    b"trailer<</Root 1 0 R>>\n"
)
