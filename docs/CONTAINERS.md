# Container images (EC2 / Kubernetes)

For architecture diagrams, see [ARCHITECTURE.md](ARCHITECTURE.md). After startup,
follow [TESTING.md](TESTING.md) for PowerShell and Bash verification commands.

Build from the repository root using separate build contexts:

```bash
docker build --build-arg KUBECTL_VERSION=v1.35.0 -t idar-agent-core:local ./agent-core
docker build --build-arg VITE_AGENT_API_URL=https://agent.example.com --build-arg VITE_CONVERTER_URL=https://converter.example.com -t idar-client:local ./client
docker build -t idar-doc-converter:local ./doc-converter
docker build -t idar-rag-server:local ./server
```

Match `KUBECTL_VERSION` to your cluster version. According to the
[Kubernetes documentation](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/),
kubectl must be within one minor version of the API server.
The downloaded binary is verified using SHA-256. The images support builds
for `linux/amd64` and `linux/arm64` (EC2 Graviton), for example:
`docker buildx build --platform linux/amd64,linux/arm64 --push -t REGISTRY/idar-agent-core:TAG ./agent-core`.
Python dependency versions still follow the ranges in `pyproject.toml`, and
base image tags are mutable; fully reproducible builds require a lockfile and image digests.

## Agent: API and webhook

The image includes Python 3.12, application dependencies, and kubectl. It runs as
UID/GID `10001:10001`, on port `8080` by default, with one Uvicorn worker.
Provide keys and configuration at runtime; `.env` is not included in the image.

Example for a host running Docker (Bash syntax):

```bash
docker run -d --name idar-agent-core \
  --restart unless-stopped \
  --env-file agent-core/.env \
  -e WEBHOOK_HOST=0.0.0.0 -e WEBHOOK_PORT=8080 \
  -e MCP_GRAFANA_URL=http://MCP_HOST:8000/sse \
  -e REPORT_OUTPUT_DIR=/data/reports \
  -e REPORTS_DB_PATH=/data/reports/reports.db \
  -e KUBECONFIG=/home/agent/.kube/config \
  --mount type=bind,src=/absolute/path/to/kubeconfig,dst=/home/agent/.kube/config,readonly \
  --mount type=volume,src=idar-reports,dst=/data \
  -p 127.0.0.1:8080:8080 \
  idar-agent-core:local
curl --fail http://localhost:8080/healthz
```

Configure `.env` using `agent-core/.env.example`, particularly the LLM provider,
its API key, and the tool and namespace allowlists. `MCP_HOST` must be reachable
from the container; `localhost` refers to the container itself. The Grafana MCP
server must be available when the API starts. The kubeconfig must be readable
by UID 10001 and contain a reachable API address and either embedded certificates
or paths to additional mounts. The image does not include the AWS CLI or other
`exec` authentication plugins.

JSON reports and the SQLite database are stored under `/data/reports`. The volume
preserves them after the container is removed. For bind mounts, configure ownership
and permissions for UID/GID 10001. The healthcheck probes HTTP `/healthz`; it does
not check the health of the LLM provider or MCP server.

Alternatively, use the same image to run polling:

```bash
docker run --rm --no-healthcheck --env-file agent-core/.env \
  -e MCP_GRAFANA_URL=http://MCP_HOST:8000/sse \
  -e REPORT_OUTPUT_DIR=/data/reports \
  --mount type=volume,src=idar-reports,dst=/data \
  idar-agent-core:local python main.py
```

For kubectl tools, add the mount and `KUBECONFIG` setting shown above. Polling
does not expose HTTP, so the healthcheck is disabled. This is an alternative
mode; `webhook_server.py` provides the API used by the web panel.

## Running inside a cluster on EC2

See [CLUSTER.md](CLUSTER.md) for the proposed namespaces, Pod separation, Services,
Ingress, storage, node placement, and initial resource budgets.

- Push the images to a registry accessible to the nodes (such as ECR) and use them in a Deployment.
- Agent: use one replica, one worker, and the `Recreate` strategy. The current queue
  and SSE broadcaster are held in process memory, and the database is local SQLite.
  Queued investigations do not survive a restart.
- Mount a PVC at `/data`. Set `runAsUser: 10001`, `runAsGroup: 10001`, and
  `fsGroup: 10001` in the Pod security context so the agent can write data.
- Use a ServiceAccount with a Role/RoleBinding allowing `get`/`list` on
  `pods` and `events` in the namespaces being diagnosed. Kubectl inside the Pod
  uses the ServiceAccount token; there is no need to copy an administrator's kubeconfig.
- Provide configuration through a ConfigMap and keys through a Secret. Set
  `MCP_GRAFANA_URL` to the MCP server's in-cluster Service address.
- Point the agent Service to port `8080`; Alertmanager sends POST requests to
  `http://<agent-service>:8080/alerts/webhook`. Set `WEBHOOK_SHARED_SECRET`
  and matching credentials in Alertmanager.
- Configure HTTP probes for `/healthz` on port `8080`, including a startupProbe
  that allows time to connect to MCP. Kubernetes does not use Docker's HEALTHCHECK.
- RAG knowledge base: `rag-server` is stateless and may run with several replicas.
  Qdrant needs a StatefulSet with a PVC (the official `qdrant/qdrant` Helm chart
  works); Ollama needs a PVC for model weights (about 5 GB for `qwen3-embedding:8b`)
  and either a GPU node or a generous CPU budget. Point `IDAR_QDRANT_URL` and
  `IDAR_OLLAMA_URL` at the in-cluster Services and configure liveness on `/healthz`,
  readiness on `/api/health`, and a startupProbe of about 90 seconds for the
  embedding probe. See [CLUSTER.md](CLUSTER.md).

## Connecting to MCP locally (Docker Desktop / PowerShell)

If the agent uses `MCP_GRAFANA_URL=http://host.docker.internal:18000/sse`,
keep port forwarding running in a separate terminal:

```powershell
kubectl --context docker-desktop port-forward --address 127.0.0.1 -n observability svc/grafana-mcp 18000:8000
```

When installing MCP locally, add
`-f example-infrastructure/values/grafana-mcp-local-values.yaml` after the base
values file. This override allows the specific Host header used by Docker Desktop;
without it, newer MCP servers return `403 forbidden: host not allowed`.
After the MCP Pod restarts, restart port forwarding, then run
`docker start idar-agent-core`. The agent API cannot start without the tunnel.

## Web panel

The panel is built using `npm ci` and `npm run build`. The resulting files are
served by [unprivileged Nginx](https://hub.docker.com/r/nginxinc/nginx-unprivileged/)
on port `8080`. The configuration supports direct navigation to React Router routes.

```bash
docker run -d --name idar-client -p 127.0.0.1:3000:8080 idar-client:local
```

`VITE_AGENT_API_URL` and `VITE_CONVERTER_URL` are absolute service URLs reachable
**from the browser**, not internal Kubernetes Service DNS names. Changing them
requires rebuilding the image. The converter URL defaults to `http://localhost:5001`.
Set the agent's `CLIENT_ALLOWED_ORIGINS` to the panel's origin. For the ingress
serving the API, disable SSE buffering and set the timeout above the 15-second
keep-alive interval.

PDF conversion is performed by the separate [doc-converter](../doc-converter/README.md)
service using Docling. It has its own image and is not included in the panel or agent
image. No Gemini key is required. The browser calls the converter directly, so its `ALLOWED_ORIGINS` must
include the panel origin (`http://localhost:3000` for the local container).

For the local setup, create `doc-converter/.env` with:

```dotenv
HOST=127.0.0.1
PORT=5001
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

Install and start the service from the repository root:

**PowerShell**

```powershell
cd doc-converter
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[dev]'
.\.venv\Scripts\python.exe -m doc_converter.app
```

**Bash**

```bash
cd doc-converter
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m doc_converter.app
```

The host-process setup downloads model weights on first use. The Docker image embeds
the default models and uses offline mode. To run the converter image locally:

```bash
docker run -d --name idar-doc-converter \
  --restart unless-stopped \
  -e ALLOWED_ORIGINS=http://localhost:3000 \
  -p 127.0.0.1:5001:5001 \
  idar-doc-converter:local
```

Wait for `http://localhost:5001/healthz` to respond before testing PDFs.
Build the local panel with both service URLs:

```bash
docker build --build-arg VITE_AGENT_API_URL=http://localhost:8090 --build-arg VITE_CONVERTER_URL=http://localhost:5001 -t idar-client:local ./client
```

An existing container continues using its old image after a build; recreate it to
use the new one. The image does not accept API tokens as build arguments because
`VITE_*` values are public in JavaScript. Use private access for this setup. Public
deployment still requires an authentication/proxy layer; if `CLIENT_API_TOKEN` or
the converter's `API_TOKEN` is set, that layer must handle authorization.

## RAG knowledge base (server)

The image follows the same conventions as the agent and converter images:
`python:3.12-slim-bookworm`, multi-stage build, UID/GID `10003:10003`, port `8080`,
one Uvicorn worker, and a `HEALTHCHECK` on `/healthz`. Dependencies are installed
from `server/uv.lock` with `uv sync --frozen`, so the Python layer is reproducible.
The embedding model is not part of the image: it runs in Ollama, vectors live in
Qdrant, and the API container itself is stateless. The settings table and the
Kubernetes notes are in [`server/README.md`](../server/README.md).

```bash
docker run -d --name idar-rag-server \
  --restart unless-stopped \
  -e IDAR_QDRANT_URL=http://QDRANT_HOST:6333 \
  -e IDAR_OLLAMA_URL=http://OLLAMA_HOST:11434 \
  -e IDAR_EMBEDDING_MODEL=qwen3-embedding:0.6b \
  -e IDAR_CORS_ORIGINS=http://localhost:3000 \
  -e IDAR_API_TOKEN=CHANGE_ME \
  -p 127.0.0.1:8100:8080 \
  idar-rag-server:local
curl --fail http://localhost:8100/healthz
```

`QDRANT_HOST` and `OLLAMA_HOST` must be reachable from the container; `localhost`
refers to the container itself. `IDAR_API_TOKEN` is optional: when set,
`/api/documents*` and `/api/search` require `Authorization: Bearer <token>`, while
`/healthz` and `/api/health` stay open for probes. `/healthz` only confirms that the
process is up; `/api/health` also checks Qdrant, runs an embedding probe, and returns
503 when either fails. The API waits for Qdrant and Ollama at startup
(`IDAR_STARTUP_RETRIES` × `IDAR_STARTUP_RETRY_SECONDS`, 60 seconds by default)
instead of crash-looping while they come up.

`server/docker-compose.yml` runs the same image together with Qdrant `v1.19.0`
(persistent `qdrant_storage` volume). Ollama runs on the host and is reached through
`host.docker.internal:11434`, which keeps native GPU access on Docker Desktop; on
native Linux Docker the host Ollama must listen beyond loopback (`OLLAMA_HOST=0.0.0.0`).
The `docker-compose.ollama.yml` overlay runs Ollama in Docker instead: a one-shot
`ollama-pull` service fetches `IDAR_EMBEDDING_MODEL` and the API starts only after it
succeeded; an NVIDIA `deploy` block is ready to uncomment.

```bash
cd server
docker compose up -d qdrant                                                       # development: API from uv, Ollama on the host
docker compose up -d --build                                                      # Qdrant + API in Docker, Ollama on the host
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d --build   # everything in Docker
```

The panel is not wired to this API yet. Once it is, its base URL will be a
browser-reachable build argument like `VITE_AGENT_API_URL`, with the same caveats.
