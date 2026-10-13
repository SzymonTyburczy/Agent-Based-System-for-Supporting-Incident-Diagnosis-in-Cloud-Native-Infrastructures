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
| `AGENT_ENVIRONMENT` | Infrastructure profile added to the prompt: `otel-demo`, a directory path, or empty for the generic prompt |
| `REPORT_OUTPUT_DIR` / `REPORTS_DB_PATH` | JSON report directory and SQLite database path |
| `WEBHOOK_SHARED_SECRET` | Bearer token for Alertmanager webhook requests |
| `CLIENT_API_TOKEN` / `CLIENT_ALLOWED_ORIGINS` | Report API authentication and allowed browser origins |

Run Grafana MCP with write tools disabled and use read-only Kubernetes permissions.
Keep secrets out of Git. Container addresses, volume paths, and environment-variable
handling are covered in [CONTAINERS.md](../docs/CONTAINERS.md).

## Prompts, skills and environments

All LLM-facing text is Markdown inside the package. `agent_core/prompts/` holds the
generic text (`core.md`, `answer.md`, `wrapup.md`, `report.md`, `incident.md`,
`fallback_question.md`) and `prompts/skills/` one file per tool group.
`agent_core/environments/<name>/` holds infrastructure facts (`environment.md`, optional
`fallback_question.md`). `agent_core/prompting.py` composes one system message per
investigation: core, then the skills whose tools are registered, then the environment
profile, then the answer format.

`AGENT_ENVIRONMENT` is empty (generic prompt, logged as a warning), a built-in name
(`otel-demo`) or a directory path. For your own profile in Kubernetes, run
`kubectl create configmap agent-core-environment -n idar --from-file=./my-env`, mount it
in the `agent-core` Deployment, set `AGENT_ENVIRONMENT` to the absolute mount path and
run `kubectl rollout restart deployment/agent-core -n idar`. Files are read once per
process, so later ConfigMap edits also need a restart.

A skill is `prompts/skills/<name>.md` with front matter `requires_any: <tool>, ...`
(base tool names, without the `grafana_` prefix); it is included when any listed tool is
registered. Placeholders are `{{now}}`, `{{max_turns}}`, `{{namespaces}}` and
`{{tool:<base name>}}`; a line naming an unregistered tool, or `{{namespaces}}` without
a namespace allowlist, is dropped. Keep files to terse bullets with each rule in one file
and no vendor-specific markup: the prompt is resent on every LLM call, and tests cap each
skill at 120 words and the full prompt at the size of the old hand-written one. Startup
and `docker build` fail on a missing file, bad front matter or an unknown placeholder;
tests reject a `{{tool:...}}` name outside the production tool set.
Skills are inlined rather than loaded on demand: the history is resent every turn anyway,
and a skill-loading tool would cost schema tokens and iterations.

## Documentation retrieval (RAG)

Set `RAG_API_URL=http://localhost:8100` for a locally running knowledge base,
or `http://rag-server:8080` inside namespace `idar` (the Kubernetes ConfigMap
already sets this). In Docker, use an address reachable from the agent container,
such as `http://host.docker.internal:8100` on Docker Desktop.
Set `RAG_API_TOKEN` to the server's `IDAR_API_TOKEN` if authentication is enabled.
An empty `RAG_API_URL` disables retrieval; the code default is empty.

Both webhook and polling modes expose the read-only `search_knowledge_base` tool
to the LLM. The knowledge-base skill (included only when `search_knowledge_base` is
registered) asks it to search once before concluding, verify hits against telemetry
and cite the passages it relies on (see
[Documentation citations](#documentation-citations)). Tool invocation and citation
remain model-driven, not a guaranteed search on every incident. Retrieved text is
reference data, not instructions for the agent.

`RAG_TOP_K` controls the number of excerpts (default 5, range 1–20).
Each excerpt is limited to 4000 characters and marked when truncated.
`RAG_TIMEOUT_SECONDS` bounds the search duration (default 30, maximum 300).
There is no RAG startup dependency: timeout, authentication or server errors become
tool errors, allowing diagnosis to continue. No matches produce an empty result.
Ingest documents through the panel before testing retrieval.

### Documentation citations

The LLM never sees or copies document IDs. Each search hit is shown with a short
key that is valid for one investigation, `[KB1]`, `[KB2]` and so on, along with its
file name, title and section. The same passage keeps its key when a later search finds
it again. The agent puts the key right after each statement that relies on the hit,
and the structuring step copies it into whichever report field that statement lands
in.

After the run, `agent_core/citations.py` maps the keys back to knowledge-base data:

- Marker variants such as `[kb1]`, `(KB1)` or `[KB1, KB3]` are rewritten as `[KB1]` /
  `[KB1][KB3]` in `problem`, `error_sources` and `remediations`. Keys the agent was
  never given are removed, so the panel cannot link to a wrong document. Markers are
  removed from `title` and `summary`. `raw_diagnosis` is kept verbatim, and so is
  `problem` when structuring failed and it repeats the raw diagnosis.
- The report's `citations` list has one entry per key used, in order of first
  mention: `key`, `doc_id`, `file_name` (the title for documents ingested without
  one), `title`, `section_path`, `chunk_index` and `quote`, which is the cited chunk
  text without the section prefix, so the panel can highlight it in the document.
- A retrieved document that the report names by file name (case-insensitive, at least
  4 characters; without the extension only when the rest reads as an identifier, such
  as `crashloop-runbook`, so `kubernetes.md` is not named by the word "Kubernetes") or
  exact title (at least two words and 8 characters) without citing any of its passages
  is listed once, with `key`, `chunk_index` and `quote` set to `null`. Retrieved
  documents the report does not use are not listed.

`citations` is part of the saved JSON report, the stored record, `GET /reports/{id}`
and both SSE events. The report list leaves it out. The Markdown export ends with a
`Documentation sources` section.

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
| POST | `/alerts/webhook` | Accept Alertmanager payloads; returns `queued` or `ignored`; 503 while 100 investigations are already waiting |
| GET | `/healthz` | HTTP availability check, not a complete dependency check |
| GET | `/reports` | List reports; optional `status=pending` or `status=resolved` filter |
| GET | `/reports/{id}` | Read a report, including Markdown content and documentation citations |
| PATCH | `/reports/{id}` | Set status with `{"status":"resolved"}` or `{"status":"pending"}` |
| GET | `/reports/stream` | SSE feed of `report_created` and `report_updated` events |

Use one worker and one replica: the queue and SSE broadcaster are in process memory.
Pending investigations do not survive a restart. Mount persistent storage for reports.
An existing reports database gains the `citations` column on startup; older reports
have no citations. The change is one-way: a previous version cannot read the upgraded
database. Back up the database before upgrading, and to roll back restore that backup
or drop the column first (`ALTER TABLE reports DROP COLUMN citations`, SQLite 3.35 or
later).

## Tests and development

After installing the `dev` dependencies, run `.\.venv\Scripts\python.exe -m pytest -q`
(PowerShell) or `.venv/bin/python -m pytest -q` (Bash), from this directory.
Tests use fake providers and MCP sessions; they do not need a live cluster or API key.
For manual webhook tests and expected results, see [TESTING.md](../docs/TESTING.md).

Core modules live under `agent_core/`: `agent/` implements the loop, `llm/` contains
provider adapters, `tools/` contains diagnostic adapters, and `report.py` /
`reports_store.py` handle report generation and storage. Add new tools through
`ToolRegistry`; Slack integration remains future work.
