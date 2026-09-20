# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm AS builder

# uv zamiast pip: instalacja z uv.lock (--frozen) daje powtarzalny obraz —
# tego CONTAINERS.md brakuje w pozostałych obrazach.
COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /bin/uv
# UV_PYTHON_PREFERENCE/DOWNLOADS: pyproject wymusza "only-managed" (obejście
# Pythona ze Store na Windows); w obrazie uv ma użyć CPythona z obrazu
# bazowego, a nie pobierać własnego.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_PREFERENCE=system \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
WORKDIR /build

# Warstwa zależności osobno od kodu: zmiana app/ nie unieważnia instalacji.
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.12-slim-bookworm AS runtime
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/rag \
    PORT=8080
# UID 10003: agent-core ma 10001, doc-converter 10002.
RUN groupadd --gid 10003 rag \
    && useradd --uid 10003 --gid rag --create-home rag
COPY --from=builder /opt/venv /opt/venv
WORKDIR /app
COPY app ./app
USER 10003:10003
EXPOSE 8080
# Płytki liveness — Kubernetes ignoruje HEALTHCHECK, sondy trzeba powtórzyć
# w manifeście (liveness: /healthz, readiness: /api/health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8080') + '/healthz', timeout=3)"
# Jeden worker: skalowanie przez repliki (proces jest bezstanowy, stan żyje
# w Qdrancie). Konfiguracja przez zmienne IDAR_* w środowisku kontenera.
CMD ["python", "-c", "import os, uvicorn; uvicorn.run('app.main:app', host='0.0.0.0', port=int(os.environ.get('PORT', '8080')), workers=1)"]
