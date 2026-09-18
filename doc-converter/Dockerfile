# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /build

COPY pyproject.toml ./
COPY doc_converter ./doc_converter

# PyPI's Linux torch package may pull the CUDA toolkit. This service is
# CPU-only, so install the official CPU wheels before resolving Docling.
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install \
        --index-url https://download.pytorch.org/whl/cpu \
        torch torchvision \
    && /opt/venv/bin/pip install . gunicorn

# Keep the runtime independent of Hugging Face availability. These are the
# two model groups used by the default pipeline (OCR and enrichment are off).
RUN /opt/venv/bin/docling-tools models download \
    --output-dir /opt/docling-models \
    layout tableformer

FROM python:3.12-slim-bookworm AS runtime

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/converter \
    HOST=0.0.0.0 \
    PORT=5001 \
    MODELS_DIR=/opt/docling-models \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

# OpenCV/torch runtime libraries required by Docling's PDF pipeline.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10002 converter \
    && useradd --uid 10002 --gid converter --create-home converter

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/docling-models /opt/docling-models

WORKDIR /app
USER 10002:10002
EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '5001') + '/healthz', timeout=3)"

# One worker and one thread: a conversion can consume several GiB of memory.
# exec replaces Python with Gunicorn so container shutdown signals reach it.
CMD ["python", "-c", "import os; from doc_converter.config import Settings; s=Settings(); os.execlp('gunicorn', 'gunicorn', '--bind', f'{s.host}:{s.port}', '--workers', '1', '--threads', '1', '--timeout', str(s.conversion_timeout_seconds + 60), '--preload', 'doc_converter.app:create_app()')"]
