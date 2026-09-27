# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm AS builder

# uv instead of pip: installing from uv.lock (--frozen) makes the image
# reproducible, which the other images described in CONTAINERS.md are not.
COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /bin/uv
# UV_PYTHON_PREFERENCE/DOWNLOADS: pyproject forces "only-managed" (a workaround
# for the Store Python on Windows); in the image uv must use the base image's
# CPython instead of downloading its own.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_PREFERENCE=system \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
WORKDIR /build

# Dependencies in their own layer: a change in app/ does not invalidate the install.
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.12-slim-bookworm AS runtime
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/rag \
    PORT=8080
# UID 10003: agent-core has 10001, doc-converter 10002.
RUN groupadd --gid 10003 rag \
    && useradd --uid 10003 --gid rag --create-home rag
COPY --from=builder /opt/venv /opt/venv
WORKDIR /app
COPY app ./app
USER 10003:10003
EXPOSE 8080
# Shallow liveness. Kubernetes ignores HEALTHCHECK, so the manifest repeats the
# probes (liveness: /healthz, readiness: /api/health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8080') + '/healthz', timeout=3)"
# One worker: scale with replicas (the process is stateless, the state lives in
# Qdrant). Configured through IDAR_* variables in the container environment.
CMD ["python", "-c", "import os, uvicorn; uvicorn.run('app.main:app', host='0.0.0.0', port=int(os.environ.get('PORT', '8080')), workers=1)"]
