"""Downloads exactly the Docling models this service runs, into MODELS_DIR.

Run once, with a network connection; afterwards the service converts with no
network at all (verified with HF_HUB_OFFLINE=1). This is also the step to run
when building a container image, so the weights are baked in rather than
pulled on first start.

Docling's own default prefetch pulls ~1.37 GB because it includes models this
service deliberately never enables — CodeFormulaV2 (611 MB) and the figure
classifier (33 MB). Restricting it to what actually runs costs ~570 MB, or
~510 MB with OCR left off.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_converter.config import Settings  # noqa: E402


def main() -> int:
    settings = Settings()
    target = settings.artifacts_path()
    if target is None:
        print(
            "MODELS_DIR is not set — Docling would download to its own cache instead.\n"
            "Set it in .env (e.g. MODELS_DIR=./models) and re-run to get a self-contained,\n"
            "offline-capable install.",
            file=sys.stderr,
        )
        return 1

    from docling.utils.model_downloader import download_models

    target.mkdir(parents=True, exist_ok=True)
    print(f"Downloading Docling models into {target} …")
    download_models(
        output_dir=target,
        progress=True,
        with_layout=True,
        with_tableformer=True,
        with_rapidocr=settings.enable_ocr,
        with_code_formula=settings.enable_code_enrichment,
        with_picture_classifier=False,
        with_smolvlm=False,
        with_smoldocling=False,
        with_granitedocling=False,
        with_granite_vision=False,
        with_easyocr=False,
    )

    total = sum(f.stat().st_size for f in target.rglob("*") if f.is_file())
    print(f"Done — {total / 1024 / 1024:.0f} MB in {target}")
    print("The service now runs offline. Verify with:")
    print("  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python -m doc_converter.app")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
