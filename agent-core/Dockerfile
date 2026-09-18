# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm AS builder

ARG TARGETARCH
# Match this to the Kubernetes API server version when building.
ARG KUBECTL_VERSION=v1.35.0
WORKDIR /build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    curl -fsSLo kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    curl -fsSLo kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256"; \
    echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check; \
    chmod 0755 kubectl

COPY pyproject.toml ./
COPY agent_core ./agent_core
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir .

FROM python:3.12-slim-bookworm AS runtime
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/agent \
    REPORT_OUTPUT_DIR=/data/reports \
    REPORTS_DB_PATH=/data/reports/reports.db \
    WEBHOOK_HOST=0.0.0.0 \
    WEBHOOK_PORT=8080
RUN groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid agent --create-home agent \
    && mkdir -p /data/reports \
    && chown -R agent:agent /data
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /build/kubectl /usr/local/bin/kubectl
WORKDIR /app
COPY main.py webhook_server.py ./
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('WEBHOOK_PORT', '8080') + '/healthz', timeout=3)"
# One worker: the investigation queue and SSE broadcaster are in process.
CMD ["python", "-c", "import uvicorn; from agent_core.config import Settings; s = Settings(); uvicorn.run('webhook_server:app', host=s.webhook_host, port=s.webhook_port, workers=1)"]
