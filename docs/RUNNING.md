# Running the full project locally

This project has four pieces. The infrastructure, agent, and client form the
incident-diagnosis flow; the client also calls the converter when a PDF is uploaded:

```
example-infrastructure  →  agent-core  →  client
  (Prometheus, Alertmanager,   (diagnostic agent,   (web panel, reads
   Grafana, mcp-grafana)        FastAPI server)       agent-core's API)

                        doc-converter  →  client
                   (PDF → Markdown, local)   (Documentation view)
```

`doc-converter` needs neither the cluster nor the agent. Start it before the client
when you want to prepare a PDF in the Documentation view. Markdown and text files
work without it. Document submission to a RAG backend is not implemented yet.

Alerts flow **infra → agent-core** (via webhook or MCP), and reports flow
**agent-core → client** (via REST + SSE). Start them in that order — each
later piece expects the one before it to already be reachable.
Run each long-lived service in a separate terminal opened at the repository root.

## Prerequisites

- Docker Desktop with Kubernetes enabled (or an equivalent local cluster)
- Python 3.11+
- Node.js 20+
- `kubectl` on your `PATH`, pointed at the target cluster
- An API key for at least one LLM provider (OpenAI or Anthropic), or
  [Ollama](https://ollama.com/) running locally for a free/offline option

## 1. Start the example infrastructure

```bash
./example-infrastructure/scripts/bash/deploy-stack.sh
```

This brings up Prometheus, Alertmanager, Grafana, and the `mcp-grafana`
MCP server. See [`example-infrastructure/README.md`](../example-infrastructure/README.md)
for exact prerequisites, ports, and how to tear it down
(`./example-infrastructure/scripts/bash/stop-stack.sh`).

Confirm it's reachable before moving on:
- Grafana MCP server: `http://localhost:8000/sse`
- Alertmanager UI: `http://localhost:9093`

## 2. Configure and start agent-core

```bash
cd agent-core
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

cp .env.example .env
# edit .env — see "Environment variables" below
```

Start the webhook API used by the web panel:

```bash
uvicorn webhook_server:app --host 127.0.0.1 --port 8090 --workers 1
```

The separate `main.py` polling process reads Grafana-managed alerts and writes JSON
only. It is not required for the panel and is not a complete fallback for Alertmanager.
See [execution modes](../agent-core/README.md#execution-modes).

⚠️ `webhook_server.py` connects to `MCP_GRAFANA_URL` **on startup** and
will not come up at all if that address isn't reachable — start the
infrastructure (step 1) first.

Confirm it's up: `curl http://localhost:8090/healthz` → `{"status":"ok"}`.

## 3. Start the document converter

Needed for the Documentation view's PDF upload; the rest of the app works without it.

```bash
cd doc-converter
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e ".[dev]"        # ~1.3 GB — Docling pulls torch
python -m doc_converter.app    # no configuration needed
```

The first host-process start downloads and loads the conversion models before it
listens. Confirm with `curl http://localhost:5001/healthz` →
`{"status":"ok","engine":"docling",…}`. The Docker image described in
[`doc-converter/README.md`](../doc-converter/README.md) already contains the models
and can run offline.

## 4. Configure and start the client

```bash
cd client
npm ci

# Configure client/.env locally; do not commit real keys.
```

```
VITE_AGENT_API_URL=http://localhost:8090
VITE_AGENT_API_TOKEN=<only if CLIENT_API_TOKEN is set in agent-core/.env>
VITE_CONVERTER_URL=http://localhost:5001
VITE_CONVERTER_TOKEN=<only if API_TOKEN is set in doc-converter/.env>
```

```bash
npm run dev
```

Open the printed URL (usually `http://localhost:5173`) and go to
`/issues` — it should load without a connection error (an empty list is
fine if no incidents have fired yet).

## Environment variables

### `agent-core/.env`

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai` \| `anthropic` \| `ollama` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | — | required if `LLM_PROVIDER=openai` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — | required if `LLM_PROVIDER=anthropic` |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3.1` | required if `LLM_PROVIDER=ollama` |
| `MCP_GRAFANA_URL` | `http://localhost:8000/sse` | Grafana MCP server address; startup fails if unreachable |
| `MCP_GRAFANA_TOOL_ALLOWLIST` | curated ~20-tool list | which MCP tools get registered (avoids TPM rate limits) |
| `KUBECTL_ALLOWED_NAMESPACES` | `otel-demo` | empty = no restriction |
| `AGENT_MAX_ITERATIONS` | `12` | ReAct loop step budget per investigation |
| `AGENT_POLL_INTERVAL_SECONDS` | `60` | `main.py` only; controls the polling interval |
| `AGENT_RUN_ONCE` | `false` | `main.py` only; one investigation then exit, for smoke tests |
| `WEBHOOK_HOST` / `WEBHOOK_PORT` | `0.0.0.0` / `8090` in `.env.example` | read by the Docker startup command; direct Uvicorn invocation uses its CLI flags |
| `WEBHOOK_SHARED_SECRET` | empty | bearer token Alertmanager must send to `/alerts/webhook`; empty = no check |
| `REPORT_OUTPUT_DIR` | `./reports` | immutable per-investigation JSON files |
| `REPORTS_DB_PATH` | `./reports/reports.db` | mutable status store the client's API reads from |
| `CLIENT_API_TOKEN` | empty | bearer token (or `?token=`) required on `/reports*`; empty = no check |
| `CLIENT_ALLOWED_ORIGINS` | empty | comma-separated CORS allowlist for `/reports*`; empty = allow any origin |

### `doc-converter/.env`

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `5001` | where the converter listens |
| `API_TOKEN` | empty | bearer token the client must send; empty = no check |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS allowlist |
| `MODELS_DIR` | empty | pre-fetched Docling weights; set it for offline operation |
| `ENABLE_OCR` | `false` | OCR for scanned PDFs (+62 MB of weights, slower) |
| `MAX_UPLOAD_BYTES` | `15728640` | mirrors the client's own 15 MB cap |

### `client/.env`

| Variable | Purpose |
|---|---|
| `VITE_AGENT_API_URL` | base URL of `agent-core`'s `webhook_server` (e.g. `http://localhost:8090`) |
| `VITE_AGENT_API_TOKEN` | only needed if `CLIENT_API_TOKEN` is set on the agent-core side |
| `VITE_CONVERTER_URL` | base URL of the `doc-converter` service (e.g. `http://localhost:5001`) |
| `VITE_CONVERTER_TOKEN` | only needed if `API_TOKEN` is set on the doc-converter side |

Never commit real values from any `.env`. Frontend `VITE_*` values are public
in the browser bundle; keep this development setup private.

## Testing

See [TESTING.md](TESTING.md) for manual webhook tests, expected results, persistence
and SSE checks, automated tests, and troubleshooting in PowerShell and Bash.
Live diagnosis requires MCP, a monitored cluster, and an LLM provider; unit tests
use mocks and do not require those services.
