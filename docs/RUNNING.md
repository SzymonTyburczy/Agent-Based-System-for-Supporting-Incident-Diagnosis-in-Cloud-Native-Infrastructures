# Running the full project locally

This project has five pieces. The infrastructure, agent, and client form the
incident-diagnosis flow; the client also calls the converter when a PDF is uploaded,
and the RAG knowledge base stores the documentation the agents will search:

```
example-infrastructure  →  agent-core  →  client
  (Prometheus, Alertmanager,   (diagnostic agent,   (web panel, reads
   Grafana, mcp-grafana)        FastAPI server)       agent-core's API)

                        doc-converter  →  client
                   (PDF → Markdown, local)   (Documentation view)

                   client  →  server  ⇠  agent-core
          (Documentation view:   (RAG knowledge base:    (knowledge-base tool,
           Send ingests docs)     Qdrant + Ollama)        not registered yet)
```

`doc-converter` needs neither the cluster nor the agent. Start it before the client
when you want to prepare a PDF in the Documentation view. Markdown and text files
work without it. `server/` (the RAG knowledge base) needs Docker for Qdrant and Ollama
for embeddings; start it before the client if you want the Documentation view's
**Send** to work. The agent's knowledge-base tool is not wired yet, so ingested
documents do not yet influence diagnoses.

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
- For the RAG knowledge base: [uv](https://docs.astral.sh/uv/) (downloads Python 3.12
  itself) and Ollama with the embedding model pulled: `ollama pull qwen3-embedding:0.6b`

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

## 4. Start the RAG knowledge base

Independent of steps 1–3; needed when you want to ingest documentation or test
retrieval. Qdrant runs in Docker, embeddings come from Ollama on the host.

```bash
ollama pull qwen3-embedding:0.6b
cd server
docker compose up -d qdrant
uv run fastapi dev app/main.py --port 8100
```

Configuration is optional: `server/.env.example` lists the `IDAR_*` variables and
the defaults match this setup. Confirm with `curl http://localhost:8100/api/health` →
`{"status":"ok","qdrant":"ok","embedding":"ok","embedding_model":"qwen3-embedding:0.6b","dimension":1024}`;
Swagger is at `http://localhost:8100/docs`. Port 8100 is deliberate: 8000 is the
Grafana MCP port-forward from step 1. To run the API in Docker instead, see
[CONTAINERS.md](CONTAINERS.md#rag-knowledge-base-server).

On Windows with Smart App Control, `uv run python -m uvicorn app.main:app --reload --port 8100`
is the equivalent that does not depend on uv's script launchers; see the
[known issues](../server/README.md#znane-problemy-windows--smart-app-control).

## 5. Configure and start the client

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
VITE_RAG_API_URL=http://localhost:8100
VITE_RAG_API_TOKEN=<only if IDAR_API_TOKEN is set in server/.env>
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

### `server/.env`

All optional; the defaults match step 4.

| Variable | Default | Purpose |
|---|---|---|
| `IDAR_EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | Ollama embedding model; `qwen3-embedding:8b` is the target. Each model gets its own Qdrant collection behind the `kb_active` alias, so switching means re-ingesting documents |
| `IDAR_OLLAMA_URL` | `http://localhost:11434` | Ollama address (`http://host.docker.internal:11434` from a container) |
| `IDAR_QDRANT_URL` | `http://localhost:6333` | Qdrant address (`http://qdrant:6333` on the compose network) |
| `IDAR_QUERY_INSTRUCTION` | English retrieval instruction | prefix added to queries only, never to documents (Qwen3-Embedding asymmetry) |
| `IDAR_CHUNK_MAX_TOKENS` / `IDAR_CHUNK_OVERLAP_TOKENS` | `600` / `80` | chunk budget and overlap for prose; code blocks and tables are never split |
| `IDAR_BREADCRUMBS` | `true` | prepend the section path (`H1 > H2`) to every chunk |
| `IDAR_CORS_ORIGINS` | `http://localhost:5173,http://localhost:3000` | comma-separated CORS allowlist; empty = allow any origin |
| `IDAR_API_TOKEN` | empty | bearer token required on `/api/documents*` and `/api/search`; empty = no check |
| `IDAR_STARTUP_RETRIES` / `IDAR_STARTUP_RETRY_SECONDS` | `30` / `2` | how long to wait for Ollama and Qdrant at startup |

### `client/.env`

| Variable | Purpose |
|---|---|
| `VITE_AGENT_API_URL` | base URL of `agent-core`'s `webhook_server` (e.g. `http://localhost:8090`) |
| `VITE_AGENT_API_TOKEN` | only needed if `CLIENT_API_TOKEN` is set on the agent-core side |
| `VITE_CONVERTER_URL` | base URL of the `doc-converter` service (e.g. `http://localhost:5001`) |
| `VITE_CONVERTER_TOKEN` | only needed if `API_TOKEN` is set on the doc-converter side |
| `VITE_RAG_API_URL` | base URL of the RAG knowledge base (e.g. `http://localhost:8100`); the Documentation view's **Send** target |
| `VITE_RAG_API_TOKEN` | only needed if `IDAR_API_TOKEN` is set on the RAG server |

Never commit real values from any `.env`. Frontend `VITE_*` values are public
in the browser bundle; keep this development setup private.

## Testing

See [TESTING.md](TESTING.md) for manual webhook tests, expected results, persistence
and SSE checks, automated tests, and troubleshooting in PowerShell and Bash.
Live diagnosis requires MCP, a monitored cluster, and an LLM provider; unit tests
use mocks and do not require those services.
