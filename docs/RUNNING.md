# Running the full project locally

This project has three pieces that need to run together:

```
example-infrastructure  →  agent-core  →  client
  (Prometheus, Alertmanager,   (diagnostic agent,   (web panel, reads
   Grafana, mcp-grafana)        FastAPI server)       agent-core's API)
```

Alerts flow **infra → agent-core** (via webhook or MCP), and reports flow
**agent-core → client** (via REST + SSE). Start them in that order — each
later piece expects the one before it to already be reachable.

## Prerequisites

- Docker Desktop with Kubernetes enabled (or an equivalent local cluster)
- Python 3.11+
- Node.js 20+
- `kubectl` on your `PATH`, pointed at the target cluster
- An API key for at least one LLM provider (OpenAI or Anthropic), or
  [Ollama](https://ollama.com/) running locally for a free/offline option

## 1. Start the example infrastructure

```bash
cd example-infrastructure
./deploy-stack.sh
```

This brings up Prometheus, Alertmanager, Grafana, and the `mcp-grafana`
MCP server. See [`example-infrastructure/README.md`](example-infrastructure/README.md)
for exact prerequisites, ports, and how to tear it down (`./stop-stack.sh`).

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

Two ways to receive alerts (see `agent-core/README.md` for the full
tradeoffs) — for local development, run **both**:

```bash
# Terminal A: push path (Alertmanager → webhook), and the API the client reads
uvicorn webhook_server:app --host 0.0.0.0 --port 8090

# Terminal B: polling path, as a reconciliation safety net (optional)
python main.py
```

⚠️ `webhook_server.py` connects to `MCP_GRAFANA_URL` **on startup** and
will not come up at all if that address isn't reachable — start the
infrastructure (step 1) first.

Confirm it's up: `curl http://localhost:8090/healthz` → `{"status":"ok"}`.

## 3. Configure and start the client

```bash
cd client
npm install

# client/.env is tracked with empty placeholders — fill in your values,
# then tell git to ignore your local changes:
git update-index --skip-worktree .env
```

```
VITE_GEMINI_API_KEY=<your Gemini key>
VITE_AGENT_API_URL=http://localhost:8090
VITE_AGENT_API_TOKEN=<only if CLIENT_API_TOKEN is set in agent-core/.env>
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
| `AGENT_POLL_INTERVAL_SECONDS` | `60` | `main.py` only; set 300+ if `webhook_server.py` also runs |
| `AGENT_RUN_ONCE` | `false` | `main.py` only; one investigation then exit, for smoke tests |
| `WEBHOOK_HOST` / `WEBHOOK_PORT` | `0.0.0.0` / `8090` | where `webhook_server.py` listens |
| `WEBHOOK_SHARED_SECRET` | empty | bearer token Alertmanager must send to `/alerts/webhook`; empty = no check |
| `REPORT_OUTPUT_DIR` | `./reports` | immutable per-investigation JSON files |
| `REPORTS_DB_PATH` | `./reports/reports.db` | mutable status store the client's API reads from |
| `CLIENT_API_TOKEN` | empty | bearer token (or `?token=`) required on `/reports*`; empty = no check |
| `CLIENT_ALLOWED_ORIGINS` | empty | comma-separated CORS allowlist for `/reports*`; empty = allow any origin |

### `client/.env`

| Variable | Purpose |
|---|---|
| `VITE_GEMINI_API_KEY` | Google Gemini key, for PDF → Markdown conversion in the Documentation view |
| `VITE_AGENT_API_URL` | base URL of `agent-core`'s `webhook_server` (e.g. `http://localhost:8090`) |
| `VITE_AGENT_API_TOKEN` | only needed if `CLIENT_API_TOKEN` is set on the agent-core side |

Never commit real values for either `.env` — both are tracked with empty
placeholders as templates; run `git update-index --skip-worktree <path>`
after filling in your own.

## Smoke test without waiting for a real alert

Once `webhook_server.py` is up, simulate an Alertmanager webhook directly:

```bash
curl -X POST http://localhost:8090/alerts/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "status": "firing",
    "groupLabels": {"alertname": "HighErrorRate", "service": "checkout-service", "severity": "critical"},
    "alerts": [{
      "status": "firing",
      "labels": {"alertname": "HighErrorRate", "service": "checkout-service", "severity": "critical", "pod": "checkout-1"},
      "annotations": {"summary": "Checkout error rate above 5%"},
      "startsAt": "2026-07-27T10:00:00Z"
    }]
  }'
```

You should get `{"status":"queued"}` back, and — once the agent finishes
investigating — the new issue should appear on the client's `/issues` page
on its own, without a page refresh (that's the SSE stream at work).

## Troubleshooting

- **`webhook_server.py` won't start at all** — almost always `MCP_GRAFANA_URL`
  unreachable. Confirm the infrastructure (step 1) is actually up first.
- **Client shows a connection error on `/issues`** — check `VITE_AGENT_API_URL`
  points at a running `webhook_server.py`, and that `CLIENT_ALLOWED_ORIGINS`
  (if set) includes the client's actual origin.
- **`401` from `/reports*`** — `CLIENT_API_TOKEN` is set on the agent side but
  `VITE_AGENT_API_TOKEN` is missing/wrong on the client side (or vice versa).
- **Issues never appear even though the webhook returns `"queued"`** — the
  investigation is still running (can take up to ~a minute depending on the
  LLM and how many tool calls it needs); check the `webhook_server.py`
  terminal output for progress or errors.