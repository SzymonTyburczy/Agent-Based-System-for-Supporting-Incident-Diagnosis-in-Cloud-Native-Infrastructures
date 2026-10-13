# Testing guide

Manual and automated checks for the agent and web panel. For system design, see
[ARCHITECTURE.md](ARCHITECTURE.md); for image builds and startup, see
[CONTAINERS.md](CONTAINERS.md) or [RUNNING.md](RUNNING.md) for development without containers.

## Prerequisites and addresses

For live tests, start the monitored cluster, Grafana MCP, the agent API, and the panel.
Configure a working LLM provider and cluster access before submitting an alert.
The RAG knowledge base (step 8) needs only Qdrant and Ollama.

| Service | Container setup used below | Development without containers |
| --- | --- | --- |
| Panel | `http://localhost:3000` | Usually `http://localhost:5173` |
| Agent API | `http://localhost:8090` | `http://localhost:8090` with the documented Uvicorn command |
| Document converter | `http://localhost:5001` (container or host process) | `http://localhost:5001` |
| Grafana MCP | Agent uses `http://host.docker.internal:18000/sse` on Docker Desktop | Agent can use `http://localhost:8000/sse` with a matching port forward |
| RAG API | `http://localhost:8100` (compose maps it to container port `8080`) | `http://localhost:8100` with `fastapi dev` |

Docker Desktop networking is a prerequisite for the `host.docker.internal` setup,
regardless of shell. Using Bash on native Linux Docker requires its own reachable
MCP address; changing shells does not change the network configuration. If running
without containers, skip `docker` checks, use the agent terminal for logs, and run
kubectl directly against the same cluster.

The tests below do not create containers or intentionally modify workloads. Restart
and report-status checks affect the local agent and its reports. Offline tests are
listed separately at the end.

## Testing the running system

Run commands from the repository root, choosing either PowerShell or Bash. Bash
examples that process JSON require `jq`. These instructions assume the addresses
above and empty `CLIENT_API_TOKEN` and `WEBHOOK_SHARED_SECRET`, with the API
bound to host loopback. If authentication is enabled, pass the corresponding token
using PowerShell's `-Headers @{ Authorization = "Bearer <token>" }` or curl's
`-H 'Authorization: Bearer <token>'` on REST requests. The two
tokens serve different callers and may have different values.

### 1. Check service availability

**PowerShell**

```powershell
docker ps --filter name=idar
Invoke-RestMethod http://localhost:8090/healthz
docker exec idar-agent-core kubectl get pods -n otel-demo --request-timeout=10s
Invoke-RestMethod http://localhost:8090/reports
```

**Bash**

```bash
docker ps --filter name=idar
curl --fail --silent --show-error http://localhost:8090/healthz
docker exec idar-agent-core kubectl get pods -n otel-demo --request-timeout=10s
curl --fail --silent --show-error http://localhost:8090/reports | jq .
```

Expected: both containers are running, health returns `status: ok`, kubectl lists
pods, and the reports endpoint returns a list (possibly empty). `/healthz` alone
does not verify LLM credentials, ongoing MCP connectivity, or diagnosis quality.

### 2. Inspect the panel

Open [Issues](http://localhost:3000/issues), select a report, and read its diagnosis.
Use **Mark resolved** and **Reopen**, then reload the page to confirm that the status
was saved. The [Dashboard](http://localhost:3000/dashboard) uses the same reports.
If there are no reports yet, create one using the next step.

### 3. Submit a synthetic alert

This exercises the real provider and diagnostic tools and consumes LLM API tokens.
It does not intentionally break a workload. Since the alert is synthetic, the agent
may correctly report that it cannot confirm a fault.

**PowerShell**

```powershell
$testName = 'ManualContainerTest-' + (Get-Date -Format yyyyMMddHHmmss)
$before = Invoke-RestMethod http://localhost:8090/reports
$beforeIds = @($before | ForEach-Object { $_.id })
$payload = @{
    status = 'firing'
    groupLabels = @{
        alertname = $testName
        service = 'frontend'
        namespace = 'otel-demo'
    }
    alerts = @(
        @{
            status = 'firing'
            labels = @{
                alertname = $testName
                service = 'frontend'
                namespace = 'otel-demo'
                severity = 'warning'
            }
            annotations = @{
                summary = 'Manual test: inspect frontend pods in otel-demo and report evidence of any actual problems.'
            }
            startsAt = (Get-Date).ToUniversalTime().ToString('o')
        }
    )
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Method Post `
  -Uri http://localhost:8090/alerts/webhook `
  -ContentType 'application/json' `
  -Body $payload

docker logs -f --tail 30 idar-agent-core
```

**Bash**

```bash
test_name="ManualContainerTest-$(date -u +%Y%m%d%H%M%S)"
before_ids=$(curl --fail --silent --show-error http://localhost:8090/reports | jq '[.[].id]')
payload=$(jq -n \
  --arg name "$test_name" \
  --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    status: "firing",
    groupLabels: {alertname: $name, service: "frontend", namespace: "otel-demo"},
    alerts: [{
      status: "firing",
      labels: {
        alertname: $name,
        service: "frontend",
        namespace: "otel-demo",
        severity: "warning"
      },
      annotations: {
        summary: "Manual test: inspect frontend pods in otel-demo and report evidence of any actual problems."
      },
      startsAt: $started
    }]
  }')

curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  --data-binary "$payload" \
  http://localhost:8090/alerts/webhook

docker logs -f --tail 30 idar-agent-core
```

Expected: the POST returns `queued`. Logs show tool execution followed by
`Saved incident report` and `Recorded report`. Use Ctrl+C to stop following logs;
this does not stop the container. Completion time depends on provider latency,
tool calls, and other queued incidents.

After completion, in the same shell session (so the captured report IDs are available):

**PowerShell**

```powershell
$after = Invoke-RestMethod http://localhost:8090/reports
$newReports = @($after | Where-Object { $_.id -notin $beforeIds })
$newReports | Select-Object id, title, service, status
```

**Bash**

```bash
curl --fail --silent --show-error http://localhost:8090/reports |
  jq --argjson before "$before_ids" \
    '.[] | select(.id as $id | $before | index($id) | not) | {id, title, service, status}'
```

Refresh Issues and open the new report. If real alerts arrived concurrently,
there may be multiple new reports: inspect their contents and the worker logs.
The API currently does not return a job ID linking the POST to a report.
Verify that the report contains evidence, states missing information, and suggests
actions without claiming to have applied them.

### 4. Check persistence

After the worker finishes, run:

**PowerShell**

```powershell
docker restart idar-agent-core
```

**Bash**

```bash
docker restart idar-agent-core
```

Wait for `Application startup complete` in the logs, then refresh Issues. Existing
reports and status changes should remain. Persistence across container replacement
also requires mounting the same data volume in the replacement container.

### 5. Check live updates separately

The SSE endpoint can be inspected without invoking the LLM:

**PowerShell**

```powershell
curl.exe -N --max-time 20 http://localhost:8090/reports/stream
```

**Bash**

```bash
curl -N --max-time 20 http://localhost:8090/reports/stream
```

A working stream returns `text/event-stream`, an initial `: connected` comment,
and keep-alive comments; status changes should produce `report_updated` events.
The timeout after 20 seconds is intentional. With authentication enabled, curl can
send an Authorization header; the browser EventSource uses a `token` query parameter.

### 6. Validate automatic alert delivery

The synthetic POST verifies the webhook-to-report path, but not Alertmanager routing.
For a full integration test, configure Alertmanager's receiver to reach the agent
from its Pod and supply `WEBHOOK_SHARED_SECRET` if enabled. `localhost:8090` inside
that Pod points to the Pod itself, not your Windows host. The loopback-only Docker
binding used above is not automatically reachable from Alertmanager.

Use a deployment with an explicitly reachable receiver URL, then trigger an agreed
test alert and confirm delivery in Alertmanager, queue acceptance in agent logs, and
report creation. Do not treat the existence of unrelated historical reports as proof
that current automatic delivery is working.

### 7. Test PDF conversion

Start [doc-converter](../doc-converter/README.md) and set its `ALLOWED_ORIGINS` to
include the panel origin (`http://localhost:3000` for Docker or `http://localhost:5173`
for Vite). The panel image must be built with `VITE_CONVERTER_URL=http://localhost:5001`;
see [CONTAINERS.md](CONTAINERS.md). Default conversion does not need an LLM key.

Use a short PDF with selectable text; replace `sample.pdf` with its actual path.

**PowerShell**

```powershell
Invoke-RestMethod http://localhost:5001/healthz
curl.exe --fail-with-body -H "Origin: http://localhost:3000" -F "file=@sample.pdf" http://localhost:5001/convert
```

**Bash**

```bash
curl --fail --silent --show-error http://localhost:5001/healthz
curl --fail-with-body -H 'Origin: http://localhost:3000' -F 'file=@sample.pdf' http://localhost:5001/convert
```

Expected: health reports `engine: docling`; conversion returns non-empty `markdown`,
`pages`, and `duration_ms`. If `API_TOKEN` is set, provide its Authorization header.
In the panel, open **Documentation**, upload the PDF, inspect Preview, and edit the
result using the Edit tab. Confirm the converter status is online. Markdown/text
uploads should work even without the converter. **Send** posts the document to the RAG
knowledge base: with the RAG API running (step 8) the confirmation names the document
and its fragment count, pressing Send twice reports it as already indexed, and with the
API stopped the draft stays on screen with the connection error. The payload carries
the uploaded file's name as `nazwa_pliku`, so the document is listed under that name
in the Knowledge base view (step 11). Step 8 exercises the same endpoint directly.

The initial host-process start may download model weights; the Docker image already
contains the default models. An image-only PDF can return 422 with OCR disabled;
multi-line code formatting has known limitations documented in the converter README.
Check headings and tables as well as the HTTP status.

### 8. Test the RAG knowledge base

Start the RAG API as described in [RUNNING.md](RUNNING.md#4-start-the-rag-knowledge-base)
or [CONTAINERS.md](CONTAINERS.md#rag-knowledge-base-server). The payload is the same
`{data, autor, tresc}` shape the panel sends from the Documentation view, plus its
optional `nazwa_pliku`, so this is the API-level version of step 7's **Send**. The
`GET` calls are what the Knowledge base view uses. Windows PowerShell 5.1 does not send
string bodies as UTF-8, so keep non-ASCII text (such as Polish diacritics) out of
these commands there, or use PowerShell 7.

**PowerShell**

```powershell
Invoke-RestMethod http://localhost:8100/api/health
$doc = @{
    data        = (Get-Date -Format yyyy-MM-dd)
    autor       = 'Manual test'
    nazwa_pliku = 'runbooks/crashloop-runbook.md'
    tresc       = "# Runbook: CrashLoopBackOff`n`n## Diagnosis`n`nThe pod restarts in a loop. Check the logs of the previous container: kubectl logs <pod> --previous."
} | ConvertTo-Json
$ingested = Invoke-RestMethod -Method Post -Uri http://localhost:8100/api/documents -ContentType 'application/json' -Body $doc
$ingested
$docId = $ingested.doc_id
$query = @{ query = 'the pod keeps restarting, how do I find the cause?'; top_k = 3 } | ConvertTo-Json
(Invoke-RestMethod -Method Post -Uri http://localhost:8100/api/search -ContentType 'application/json' -Body $query).results | Select-Object score, file_name, title, section_path
(Invoke-RestMethod http://localhost:8100/api/documents).documents | Select-Object doc_id, file_name, title, chunk_count
Invoke-RestMethod "http://localhost:8100/api/documents/$docId" | Select-Object file_name, title, content_source, content | Format-List
Invoke-RestMethod -Method Delete -Uri "http://localhost:8100/api/documents/$docId"
curl.exe --silent --show-error --write-out ' %{http_code}' "http://localhost:8100/api/documents/$docId"
```

**Bash**

```bash
curl --fail --silent --show-error http://localhost:8100/api/health | jq .
doc=$(jq -n --arg data "$(date -u +%Y-%m-%d)" \
  '{data: $data, autor: "Manual test", nazwa_pliku: "runbooks/crashloop-runbook.md", tresc: "# Runbook: CrashLoopBackOff\n\n## Diagnosis\n\nThe pod restarts in a loop. Check the logs of the previous container: kubectl logs <pod> --previous."}')
ingested=$(curl --fail --silent --show-error -H 'Content-Type: application/json' --data-binary "$doc" http://localhost:8100/api/documents)
echo "$ingested" | jq .
doc_id=$(echo "$ingested" | jq -r .doc_id)
curl --fail --silent --show-error -H 'Content-Type: application/json' \
  --data '{"query": "the pod keeps restarting, how do I find the cause?", "top_k": 3}' \
  http://localhost:8100/api/search | jq '.results[] | {score, file_name, title, section_path}'
curl --fail --silent --show-error http://localhost:8100/api/documents |
  jq '.documents[] | {doc_id, file_name, title, chunk_count}'
curl --fail --silent --show-error "http://localhost:8100/api/documents/$doc_id" |
  jq '{file_name, title, content_source, content}'
curl --fail --silent --show-error -X DELETE "http://localhost:8100/api/documents/$doc_id"
curl --silent --show-error --write-out ' %{http_code}\n' "http://localhost:8100/api/documents/$doc_id"
```

Expected: health returns `status: ok` with the model name and vector dimension
(`1024` for `qwen3-embedding:0.6b`, `4096` for `8b`). The first POST returns `201`
with a `doc_id`, `title: "Runbook: CrashLoopBackOff"` and `chunk_count: 1` (the
heading-only H1 produces no chunk of its own). Repeating the same POST returns `200`
with `already_exists: true`: document ids are derived from the content, so re-sending
never duplicates anything. The search lists the runbook first with `section_path`
`["Runbook: CrashLoopBackOff", "Diagnosis"]`; the score is a cosine similarity
(about 0.73 for this paraphrase on `0.6b`) and its absolute value differs
between models, so compare rankings, not raw scores. Search results carry
`file_name` but never the document's full `content`.

The list (newest first, metadata only) and the single document both show
`file_name: "crashloop-runbook.md"`: the server keeps only the bare name, so the path
(a Windows one too) is dropped. Without `nazwa_pliku` the field is `null`, and over
255 characters the POST returns `422`. The single document adds `content`, the
Markdown exactly as sent, and `content_source: "stored"`. DELETE returns `204`, after
which `GET /api/documents` no longer lists the document and its `GET` returns
`{"detail":"Document '<doc_id>' not found."} 404`. With `IDAR_API_TOKEN` set, pass
the Authorization header on the `/api/documents` and `/api/search` calls;
`/api/health` stays open.

### 9. Agent retrieval from the knowledge base

Keep the runbook ingested in step 8 (or ingest it again after that step's DELETE).
Set `RAG_API_URL=http://localhost:8100` for a host-process agent, or
`http://host.docker.internal:8100` for the Docker Desktop agent. The Kubernetes
ConfigMap uses `http://rag-server:8080`. Set `RAG_API_TOKEN` to match the server's
`IDAR_API_TOKEN` when configured. Restart the host process, recreate the Docker
container with the new environment, or restart the Kubernetes Deployment.

Submit an alert as in step 3 with symptoms matching the runbook. Startup logs should
list `search_knowledge_base`; a retrieval call logs `tool=search_knowledge_base`.
The knowledge-base skill is in the system prompt only when `RAG_API_URL` is set; the
`System prompt:` log line lists it under `skills=`.
The tool shows the model each hit under a short key (`[KB1]`, `[KB2]`, …) instead
of document ids. The diagnosis should put that key after each statement that relies
on the runbook, alongside telemetry evidence. Retrieval and citing are chosen by the
LLM, so a report alone does not prove it called the tool, and a report without
citations is not an error. No matches or unavailable RAG should allow diagnosis to
continue with the missing documentation context noted. Clear `RAG_API_URL` to
disable the tool entirely. These live checks use the configured LLM provider.

After the report is saved, run step 3's listing in the same shell session. Then read
the new report's citations:

**PowerShell**

```powershell
$report = Invoke-RestMethod "http://localhost:8090/reports/$($newReports[0].id)"
$report.problem
$report.citations | Select-Object key, file_name, section_path, chunk_index
```

**Bash**

```bash
report_id=$(curl --fail --silent --show-error http://localhost:8090/reports |
  jq -r --argjson before "$before_ids" \
    '[.[] | select(.id as $id | $before | index($id) | not)][0].id')
curl --fail --silent --show-error "http://localhost:8090/reports/$report_id" |
  jq '{problem, citations: [.citations[] | {key, file_name, section_path, chunk_index}]}'
```

Expected: `citations` has one entry per cited passage, in order of first mention.
Each entry has `key` (`KB1`, …), the runbook's `doc_id`, `file_name`
(`crashloop-runbook.md` when it was sent with that name, otherwise its title),
`title`, `section_path` (`["Runbook: CrashLoopBackOff", "Diagnosis"]`), `chunk_index`,
and `quote`, which is the cited chunk text without the
`Runbook: CrashLoopBackOff > Diagnosis` line. The same keys appear as `[KB1]` (several
as `[KB1][KB2]`) in `problem`, `error_sources`, and `remediations`. Keys the agent was
never given are removed, and `title` and `summary` have no markers. If the report
names the runbook by file name or title without citing a passage, the runbook is
listed with `key`, `chunk_index`, and `quote` set to `null`. `GET /reports` does not
include citations. **Copy Markdown** ends with a `Documentation sources` section.
Reports created before citations existed return `citations: []`.

### 10. Open a cited passage in the panel

Open the report from step 9 in [Issues](http://localhost:3000/issues). If its
`citations` list was empty, the agent did not cite the runbook: submit another alert.

- A **Documentation sources** card follows **Suggested remediations**. Each cited
  passage is a chip with its number, file name, and section, such as
  `[1] crashloop-runbook.md Runbook: CrashLoopBackOff > Diagnosis`. Hovering a chip
  shows the start of the passage. A whole-document citation shows a file icon and the
  file name only. A report without citations has no card.
- In **Problem**, **Error sources**, **Suggested remediations**, and the raw
  diagnosis, each `[KBn]` marker becomes a small numbered chip with the same number as
  in the card. A marker naming a key the report does not list stays plain text.
- Click a chip. The URL gains `?doc=<doc_id>&cite=KB1`, and the document opens in a
  panel beside the report. In a window narrower than 1280 px, the panel appears under
  the report, and the page scrolls down to it. The panel scrolls inside itself to the
  highlighted passage; the report does not move. Scroll the panel away and click the
  same chip again: it scrolls back. Clicking another chip switches the panel without
  adding a history entry.
- Press the browser's Back button, or the panel's close button: the panel closes and
  `doc` leaves the URL. Reloading a URL that has `?doc=…&cite=…` opens the report with
  the panel already at the passage. A whole-document chip opens the document at the
  top, without `cite` in the URL.

When the viewer cannot find the passage, it highlights the cited section's heading
instead. If the heading is missing too, it opens at the top with "Couldn't find the
cited passage — showing the whole document." Matching ignores whitespace, and the
quote is the chunk text the document was indexed from, so this needs a quote that
differs from the document's Markdown in more than whitespace. A reconstructed document
(step 11) is rebuilt from those same chunks and always contains its cited passages.
These fallbacks are hard to provoke with real data; the `DocumentViewer` component
tests cover them.

### 11. Browse the knowledge base in the panel

Ingest a document or two (step 7's **Send**, or step 8 without its DELETE), then
open [Knowledge base](http://localhost:3000/knowledge-base).

- The list shows the documents, newest first. Each row shows the file name (or the
  title, for a document sent without one), the title under it when different, and
  then the author, date, and fragment count.
- Type in the search box. The list keeps the documents whose file name or title
  contains every word typed, ignoring case and diacritics (`lodz` finds `Łódź.md`).
  The counter shows `N of M documents`, and a query that matches nothing says so.
- Select a document. It opens beside the list (under it in a narrower window) with its
  full Markdown, and the URL gains `?doc=<doc_id>`; Back closes it. Images in a
  document are shown as an `[image: …]` placeholder and never loaded.
- **Refresh** reloads the list. The panel caches documents for 30 seconds, and a
  **Send** in Documentation updates the cache at once. A document ingested from a
  terminal appears after **Refresh**, or when the view is opened again more than
  30 seconds later.
- **Delete** (the trash icon) asks for confirmation and then removes the row. If the
  viewer showed that document, it closes. A chip in step 10's report that cites the
  deleted document now opens a panel saying "This document is no longer in the
  knowledge base." Sending the same Markdown again restores it under the same
  `doc_id`, since ids are a hash of the content, and the citations work again.

A document ingested before the server stored the full Markdown is shown rebuilt from
its chunks. To see how the panel shows one, strip a test document back to that state
in Qdrant. This edits Qdrant directly, so use it on a test document only. The
compose file publishes Qdrant on `127.0.0.1:6333`, and the server's collection is
behind the default `kb_active` alias. Run step 8 without its DELETE, then, in the same
shell session:

**PowerShell**

```powershell
$strip = @{
    keys   = @('content', 'file_name')
    filter = @{ must = @(@{ key = 'doc_id'; match = @{ value = $docId } }) }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri 'http://localhost:6333/collections/kb_active/points/payload/delete?wait=true' -ContentType 'application/json' -Body $strip
Invoke-RestMethod "http://localhost:8100/api/documents/$docId" | Select-Object file_name, title, content_source, content | Format-List
```

**Bash**

```bash
curl --fail --silent --show-error -H 'Content-Type: application/json' \
  --data "$(jq -n --arg id "$doc_id" '{keys: ["content", "file_name"], filter: {must: [{key: "doc_id", match: {value: $id}}]}}')" \
  'http://localhost:6333/collections/kb_active/points/payload/delete?wait=true' | jq .
curl --fail --silent --show-error "http://localhost:8100/api/documents/$doc_id" |
  jq '{file_name, title, content_source, content}'
```

Expected: the document now has `content_source: "reconstructed"` and
`file_name: null`. Its `content` is rebuilt from the chunks, so for step 8's runbook it
starts at `## Diagnosis`: the heading-only H1 made no chunk. After a page reload, the
Knowledge base row shows the title, and the viewer notes "Reconstructed from its
indexed fragments …". Repeat step 8's POST: it returns `already_exists: true` and
upgrades the document in place, so its `GET` shows `content_source: "stored"` with the
file name again. Then run step 8's DELETE.

## Automated tests without live infrastructure

The backend tests use fake providers, mocked MCP sessions, and isolated report stores.
They do not require a running cluster or live LLM requests. From the repository root,
with Python 3.11+ and Node/npm installed:

**PowerShell**

```powershell
cd agent-core
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[dev]'
.\.venv\Scripts\python.exe -m pytest -q
cd ..

cd client
npm.cmd ci
npm.cmd test
npm.cmd run build
cd ..
```

**Bash**

```bash
cd agent-core
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest -q
cd ..

cd client
npm ci
npm test
npm run build
cd ..
```

Dependency installation requires network access. Backend tests cover the agent loop,
tool adapters, incident parsing, report generation, citation resolution, storage, and
API behavior. Frontend tests cover API mapping, document conversion, the
knowledge-base requests and search, and the citation helpers (markers to chips,
finding a cited passage). A few components are rendered to static markup to check
the chips, highlights, and viewer notes. The build also checks TypeScript. These
checks complement, rather than replace, the live flow above. Building the
`agent-core` image also fails when prompt files are missing from the installed package.

The converter also has an independent test suite using an injected pipeline, without
loading Docling models. After installing its development dependencies, run from the
repository root:

**PowerShell**

```powershell
cd doc-converter
.\.venv\Scripts\python.exe -m pytest -q
cd ..
```

**Bash**

```bash
cd doc-converter
.venv/bin/python -m pytest -q
cd ..
```

The RAG knowledge base tests run against a fake embedding provider and an in-memory
Qdrant; `uv` creates the environment from `uv.lock` on first use. The same command
works in both shells:

```bash
cd server
uv run python -m pytest -q
cd ..
```

Two `slow` tests (`uv run python -m pytest -q -m slow`) call the real
`qwen3-embedding:0.6b` through Ollama and are deselected by default.

## Troubleshooting

| Symptom or limitation | Meaning / next check |
| --- | --- |
| Agent exits while connecting to MCP | Check the configured URL, Service, and port-forward process before restarting the agent. |
| MCP returns `403: host not allowed` | Apply the local Host allowlist override; keep Host validation enabled. |
| `Tool` has no `inputSchema` attribute | The adapter uses MCP SDK 1.x. The project constrains `mcp>=1.2,<2`; rebuild older images that installed 2.x. |
| Panel cannot reach the API | Check its build-time URL, actual port mapping, `CLIENT_ALLOWED_ORIGINS`, and API authentication. |
| `queued` but no report | Inspect worker logs for provider errors, tool failures, or storage errors. There is no durable job-status API. |
| Missing evidence from a namespace | Check both `KUBECTL_ALLOWED_NAMESPACES` and Kubernetes RBAC; changing the allowlist does not grant permissions. |
| Reports disappear after container replacement | Check `/data` mounts and `REPORT_OUTPUT_DIR` / `REPORTS_DB_PATH`. |
| Converter offline or PDF upload fails in the browser | Check converter `/healthz`, build-time `VITE_CONVERTER_URL`, and `ALLOWED_ORIGINS` matching the panel origin. |
| RAG API exits with `Embedding provider startup probe failed` after about a minute | Ollama is unreachable or the model is not pulled: `ollama pull qwen3-embedding:0.6b`; check `IDAR_OLLAMA_URL` (`host.docker.internal` from a container, `OLLAMA_HOST=0.0.0.0` on native Linux). |
| RAG `/api/health` returns 503 | The JSON names the failing side: `qdrant` (container down or wrong `IDAR_QDRANT_URL`) or `embedding` (Ollama or model). `/healthz` stays 200 because it only checks the process. |
| RAG search returns an empty `results` list | Nothing is ingested for the active collection; check `GET /api/documents`. Changing `IDAR_EMBEDDING_MODEL` switches to a new, empty collection, so ingest the documents again. |
| Knowledge base view shows "Couldn't reach the knowledge base." | Check the RAG API's `/api/health`, the panel's build-time `VITE_RAG_API_URL`, and `IDAR_CORS_ORIGINS` matching the panel origin. |
| A report has no **Documentation sources** | The agent did not search or did not cite: look for `tool=search_knowledge_base` in the logs and `[KBn]` markers in the raw diagnosis. Only keys handed out in the same investigation resolve. Reports created before citations existed have none. |
| The document panel says "This document is no longer in the knowledge base." | The cited document was deleted, or `IDAR_EMBEDDING_MODEL` changed and switched to another collection. Sending the same Markdown again restores the same `doc_id`. |
| The document panel says "Couldn't find the cited passage" | Neither the passage nor its section heading is in the document's text: the citation's `quote` differs from the document's Markdown in more than whitespace. A reconstructed document is not the cause, since it is rebuilt from the same chunks the quotes come from. Compare the `quote` in `GET /reports/{id}` with the document's `content`; the citation still opens the right document. |
| `Failed to spawn: pytest` (os error 4551) on Windows | Smart App Control blocks uv's script launchers; use `uv run python -m pytest` and `python -m uvicorn` (see `server/README.md`). |
