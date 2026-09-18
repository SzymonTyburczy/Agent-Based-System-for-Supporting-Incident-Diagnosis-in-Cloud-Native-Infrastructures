# agent-core

Python/FastAPI agent for diagnosing Kubernetes incidents using an LLM, read-only
kubectl tools, and a Grafana MCP server. It produces diagnostic reports and
recommended actions; it does not apply infrastructure changes.

- [Architecture and flow diagrams](../docs/ARCHITECTURE.md)
- [Testing guide (PowerShell and Bash)](../docs/TESTING.md)
- [Docker / Kubernetes deployment](../docs/CONTAINERS.md)
- [Development history and validation notes](../docs/agent-core/DEVELOPMENT_HISTORY.md)

## Requirements

Python 3.11+, a reachable Grafana MCP server, and an LLM provider (OpenAI,
Anthropic, or Ollama). The kubectl tools also require kubectl on PATH and access
to the target cluster. Start MCP before starting the agent API.

## Quick start

Run from the repository root. Configure the monitoring stack using the
[infrastructure guide](../example-infrastructure/README.md).

**PowerShell**

```powershell
cd agent-core
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[dev]'
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# Edit .env before starting the API.
.\.venv\Scripts\python.exe -m uvicorn webhook_server:app --host 127.0.0.1 --port 8090 --workers 1
```

**Bash**

```bash
cd agent-core
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
if [ ! -f .env ]; then cp .env.example .env; fi
# Edit .env before starting the API.
.venv/bin/python -m uvicorn webhook_server:app --host 127.0.0.1 --port 8090 --workers 1
```

Set `LLM_PROVIDER`, the matching API key or Ollama endpoint/model, and
`MCP_GRAFANA_URL` in `.env`. Check `http://localhost:8090/healthz` after startup.
The explicit Uvicorn flags above set the listening address and port; they do not
read `WEBHOOK_HOST` or `WEBHOOK_PORT`. The Docker startup command does read them.

## Configuration

See [.env.example](.env.example) for the full template and
[agent_core/config.py](agent_core/config.py) for settings and defaults.

| Setting | Purpose |
| --- | --- |
| `LLM_PROVIDER` | `openai`, `anthropic`, or `ollama`; use the corresponding key/model settings |
| `MCP_GRAFANA_URL` | Reachable Grafana MCP SSE endpoint |
| `MCP_GRAFANA_TOOL_ALLOWLIST` | Limit available tools and the schemas sent to the LLM; keep the curated list as a starting point |
| `KUBECTL_ALLOWED_NAMESPACES` | Limit namespaces used by kubectl; Kubernetes RBAC must also permit access |
| `AGENT_MAX_ITERATIONS` | Investigation step budget |
| `REPORT_OUTPUT_DIR` / `REPORTS_DB_PATH` | JSON report directory and SQLite database path |
| `WEBHOOK_SHARED_SECRET` | Bearer token for Alertmanager webhook requests |
| `CLIENT_API_TOKEN` / `CLIENT_ALLOWED_ORIGINS` | Report API authentication and allowed browser origins |

Run Grafana MCP with write tools disabled and use read-only Kubernetes permissions.
Keep secrets out of Git. Container addresses, volume paths, and environment-variable
handling are covered in [CONTAINERS.md](../docs/CONTAINERS.md).

## Execution modes

| Entry point | Behavior | Output |
| --- | --- | --- |
| `webhook_server.py` via Uvicorn | Receives alerts, processes one queued incident at a time, serves the panel API | JSON files and SQLite records |
| `main.py` | Polls Grafana-managed alerts; investigates when the firing set changes | JSON files only |

Use the webhook API for the web panel. Polling does not replace it or automatically
read Prometheus/Alertmanager alerts. For polling, run `main.py` with the virtualenv's
Python. Set `AGENT_POLL_INTERVAL_SECONDS` for the interval or `AGENT_RUN_ONCE=true`
for a single investigation. Running both modes may duplicate diagnoses.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/alerts/webhook` | Accept Alertmanager payloads; returns `queued` or `ignored` |
| GET | `/healthz` | HTTP availability check, not a complete dependency check |
| GET | `/reports` | List reports; optional `status=pending` or `status=resolved` filter |
| GET | `/reports/{id}` | Read a report, including Markdown content |
| PATCH | `/reports/{id}` | Set status with `{"status":"resolved"}` or `{"status":"pending"}` |
| GET | `/reports/stream` | Intended SSE feed; see the route-ordering limitation in the testing guide |

Use one worker and one replica: the queue and SSE broadcaster are in process memory.
Pending investigations do not survive a restart. Mount persistent storage for reports.

## Tests and development

After installing the `dev` dependencies, run `.\.venv\Scripts\python.exe -m pytest -q`
(PowerShell) or `.venv/bin/python -m pytest -q` (Bash), from this directory.
Tests use fake providers and MCP sessions; they do not need a live cluster or API key.
For manual webhook tests and expected results, see [TESTING.md](../docs/TESTING.md).

Core modules live under `agent_core/`: `agent/` implements the loop, `llm/` contains
provider adapters, `tools/` contains diagnostic adapters, and `report.py` /
`reports_store.py` handle report generation and storage. Add new tools through
`ToolRegistry`; RAG and Slack integration remain future work.
