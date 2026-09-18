# Testing guide

Manual and automated checks for the agent and web panel. For system design, see
[ARCHITECTURE.md](ARCHITECTURE.md); for image builds and startup, see
[CONTAINERS.md](CONTAINERS.md) or [RUNNING.md](RUNNING.md) for development without containers.

## Prerequisites and addresses

For live tests, start the monitored cluster, Grafana MCP, the agent API, and the panel.
Configure a working LLM provider and cluster access before submitting an alert.

| Service | Container setup used below | Development without containers |
| --- | --- | --- |
| Panel | `http://localhost:3000` | Usually `http://localhost:5173` |
| Agent API | `http://localhost:8090` | `http://localhost:8090` with the documented Uvicorn command |
| Document converter | `http://localhost:5001` (container or host process) | `http://localhost:5001` |
| Grafana MCP | Agent uses `http://host.docker.internal:18000/sse` on Docker Desktop | Agent can use `http://localhost:8000/sse` with a matching port forward |

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

The intended SSE endpoint can be inspected without invoking the LLM:

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

**Current limitation:** `webhook_server.py` registers `/reports/{report_id}` before
`/reports/stream`. The dynamic route can capture `stream` as a report ID and return
404 instead of opening SSE. Until route ordering is fixed, refresh the page to load
new reports; passing the REST checks does not prove that live updates work.

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
uploads should work even without the converter. **Send** still logs a payload rather
than persisting documents to a RAG backend.

The initial start may download model weights. An image-only PDF can return 422 with
OCR disabled; multi-line code formatting has known limitations documented in the
converter README. Check headings and tables as well as the HTTP status.

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
tool adapters, incident parsing, report generation, storage, and API behavior.
Frontend tests cover API mapping and document conversion helpers; the build also
checks TypeScript. These checks complement, rather than replace, the live flow above.

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
