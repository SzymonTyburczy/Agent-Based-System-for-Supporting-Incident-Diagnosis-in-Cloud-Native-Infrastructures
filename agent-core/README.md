# agent-core — extensible agent skeleton (role 2 of the team split)

## How the agent works, in plain language

Think of the agent as a small, focused assistant with exactly two jobs:
*notice something might be wrong*, and *figure out why* — without ever
touching or changing anything itself.

1. **Something happens.** Either someone asks it a question directly, or —
   the actual intended use — a monitoring alert fires somewhere in the
   cluster (e.g. "checkout is throwing errors") and gets handed to the
   agent automatically, either because it noticed the alert itself or
   because the alert was pushed to it directly.
2. **It decides what to check.** The agent doesn't guess — it reads the
   situation and goes and looks: is a pod crashing? What do the logs say?
   Are error rates or latency up? It can only *look*, using a fixed set of
   read-only tools (checking pod status, running log/metric queries,
   listing alerts) — it can't restart anything, delete anything, or change
   any configuration.
3. **It works step by step, like a human on-call engineer would.** Check
   something, look at the result, decide what to check next: "pods look
   healthy, let me check the logs" → "logs are quiet, let me check the
   metrics" → and so on. This repeats until it has enough evidence to
   explain what's wrong, or it runs out of the step budget it's been given
   — in which case it still summarizes whatever it found rather than just
   giving up silently.
4. **It writes a short report and saves it.** Once it's done, a separate
   step turns its explanation into a fixed structure — a title, where the
   evidence came from, what's actually wrong, and what to do about it — and
   saves that as a JSON file on disk, so the finding isn't lost even if
   nobody was watching the screen when it finished. A person still decides
   what to actually do with that report.

The rest of this document is the technical detail behind those four steps.

## Overview

An extensible skeleton for an agent application that supports incident
diagnosis in cloud-native infrastructure. Designed so that:

- the **LLM provider can be swapped easily** (OpenAI / Anthropic / Ollama)
  through a single environment variable, with no changes to the agent code,
- **CLI-based tools and MCP-based tools are treated identically** — the agent
  operates on one `Tool` interface regardless of what runs underneath,
- the rest of the team (RAG component, Slack interface, infrastructure) gets
  stable integration points without having to wait for the final version of
  the remaining components.

Milestones covered from the implementation plan: **1** (interface skeleton +
tests on mocks), **2** (one provider working end-to-end), **3** (a second
provider — validating that the architecture indeed reduces this to a
configuration change), **5** (integration with a Grafana MCP server, here
tested against a reference observability infrastructure module).

## Structure

```
agent_core/
  llm/                  # LLMProvider abstraction + implementations
    base.py              #   Message, ToolCall, ToolSchema, LLMResponse, LLMProvider
    openai_provider.py    #   OpenAIProvider (Chat Completions + function calling)
    anthropic_provider.py #   AnthropicProvider (Messages API + tool use)
    ollama_provider.py    #   OllamaProvider (subclasses OpenAIProvider — compatible endpoint)
  tools/                 # common tool interface
    base.py               #   Tool, ToolResult
    registry.py            #   ToolRegistry
    cli_tools.py            #   kubectl tools (read-only, namespace allowlist, JSON-filtered summaries)
    mcp_client.py            #   MCPServerConnection + MCPTool — MCP-to-Tool adapter
  agent/
    state.py               #   ConversationState (message history)
    loop.py                  #   AgentLoop — ReAct loop
  incident.py              # system prompt (with current time), incident description
                            # (from live firing alerts via MCP, or an Alertmanager webhook
                            # payload, or a fallback question), and alert-change detection
                            # for the polling loop — pure, unit-tested functions; main.py
                            # and webhook_server.py only wire them to actual calls
  report.py                # turns the final free-text diagnosis into a structured
                            # {title, error_sources, problem, remediations} JSON report
                            # and saves it to disk — see "Saving diagnosis reports" below
  config.py               # pydantic-settings + provider factory (build_provider)
main.py                  # polling entry point (or single-shot with AGENT_RUN_ONCE=true)
webhook_server.py        # push entry point — FastAPI receiver for Alertmanager webhooks
tests/                    # tests on mocks — no API keys or a live MCP server required
```

## How it works (in short)

1. `AgentLoop.run()` adds the system prompt and the user's question to
   `ConversationState`, then repeatedly calls `LLMProvider.complete()`,
   passing the list of available tools (`ToolRegistry.schemas()`).
2. If the model returns `tool_calls`, the agent calls
   `ToolRegistry.call(name, args)` and appends the result to the state as a
   `TOOL`-role message.
3. The loop ends once the model responds without `tool_calls`, or once
   `max_iterations` is reached.
4. `ToolRegistry` does not distinguish CLI tools from MCP tools — both kinds
   implement the same `Tool` interface with an `execute()` method.

## Running against a live environment

Assuming a Grafana MCP server is reachable (in the reference infrastructure
module used for validation: `http://localhost:8000/sse`, started with
`--disable-write: true`):

```bash
python -m venv .venv
source .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

cp .env.example .env
# fill in OPENAI_API_KEY or ANTHROPIC_API_KEY, set LLM_PROVIDER

python main.py
```

The script:
1. connects to the configured `MCP_GRAFANA_URL`,
2. discovers tools (`query_prometheus`, `query_loki_logs`, `alerting_manage_rules`,
   `search_dashboards`, ...) and registers them with a `grafana_` prefix,
   restricted to the allowlist in `.env`,
3. registers the local `kubectl_get_pods` / `kubectl_pod_diagnostics` tools
   (if `kubectl` is on PATH and points at the target cluster),
4. by default, **runs forever**: it polls the alerting tool every
   `AGENT_POLL_INTERVAL_SECONDS` (default 60s), and starts a fresh
   investigation whenever the set of firing alerts changes since the last
   one (`agent_core/incident.py::alerts_signature`) — an alert that stays
   firing across many poll cycles triggers exactly one investigation, not
   one per cycle. Stop it with Ctrl+C.
   Set `AGENT_RUN_ONCE=true` for a single investigation and exit instead
   (from whatever is firing right now, or the static example question if
   nothing is) — useful for a quick smoke test without waiting for a real
   alert.
5. each investigation runs with a system prompt that includes the current
   UTC time (`agent_core/incident.py::build_system_prompt`) as an explicit
   reference point for relative time windows, prints its full conversation
   transcript (including tool calls), and saves a structured JSON report
   under `REPORT_OUTPUT_DIR` (see "Saving diagnosis reports to disk").

## Swapping the LLM provider

```bash
# .env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

That's it — `agent_core/config.py::build_provider()` is the only place aware
of multiple providers existing. `AgentLoop` and `ToolRegistry` only see
`LLMProvider` (the interface).

Local provider (Ollama) for testing without a paid API:

```bash
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.1     # or another model that supports tool calling
```

## Tests

Tests run fully offline — against a fake provider (`FakeProvider`) and a fake
MCP session (`FakeSession`), so no API keys or a running infrastructure are
required:

```bash
pytest -v
```

Coverage includes:
- `AgentLoop`: the happy path (tool call → final answer), tool-error handling
  without crashing the agent, the wrap-up summary call when the iteration
  budget is exhausted (and its fallback if that call also fails), and not
  duplicating the system prompt across multiple turns,
- `ToolRegistry`: registration, duplicates, calling an unknown tool, calling
  with invalid arguments,
- `MCPTool` / `MCPServerConnection`: converting `list_tools()` into `Tool`
  objects, correctly mapping a prefixed local name to the remote name on
  `call_tool`, propagating an error reported by the MCP server, and
  filtering the discovered tool set with an allowlist/predicate,
- `cli_tools`: reducing a raw pod JSON document to diagnosis-relevant
  fields (including an OOMKilled/CrashLoopBackOff scenario), filtering
  events down to Warnings, and the character-count safety net,
- `incident`: rendering the system prompt with an injected time (so it's
  deterministic in tests), building the incident description from
  firing-alert data vs. falling back to the example question, the
  alert-signature comparison used to avoid re-investigating an alert that's
  still firing on every poll cycle, and parsing Alertmanager's webhook
  payload (firing vs. resolved, malformed input, multiple alerts in one
  group),
- `report`: extracting the fixed fields from a valid structuring response
  (including one wrapped in a markdown code fence), the graceful fallback
  when that response isn't valid JSON or the call fails outright, writing
  the expected JSON file structure to disk, and creating missing output
  directories.

## Known issue: rate limiting when registering every MCP tool

The first run against a live environment surfaced a real problem: the
Grafana MCP server returned 65 tools (on-call scheduling, incident
management, plugins, provisioning, snapshots — not only metrics/logs). The
schema of every registered tool is sent to the model on every turn of the
ReAct loop, so with 65 tools plus the kubectl tools it is easy to exhaust a
tokens-per-minute (TPM) rate limit before the conversation content itself is
even accounted for — which is exactly what happened
(`429 rate_limit_exceeded`, on a tier with a 30,000 TPM limit).

Addressed in two ways:

1. **Client-side filtering** — `MCPServerConnection.discover_tools()` now
   accepts `only` (an allowlist of tool names) and/or `predicate` (an
   arbitrary `str -> bool` function). `main.py` uses
   `Settings.mcp_tool_allowlist()`, populated in `.env.example` with a
   curated list of roughly 20 tools actually needed for diagnosis
   (Prometheus, Loki, dashboards, alerts) — everything else is skipped
   during registration.
2. **Agent loop resilience** — a provider error (rate limit, timeout) no
   longer crashes the process with a raw traceback; `AgentLoop` catches the
   exception and ends the turn with a readable message in
   `ConversationState`, which matters once this is wired up to the Slack
   interface — the user gets a meaningful message instead of silence or a
   crash.

**Server-side alternative** (worth discussing with whoever owns the
infrastructure component, if restricting at the source is preferred over
client-side filtering): `mcp-grafana` supports flags such as
`--disable-oncall`, `--disable-incident`, etc. at startup — in that case
`list_tools()` never returns those categories in the first place, and no
client-side filtering is needed. Client-side filtering has the advantage
that different consumers of the same MCP server (e.g. this agent vs. someone
else's editor integration) can each apply a different allowlist without
changing the server configuration.

## Known issue: iteration budget exhausted on a multi-source diagnosis

With the allowlist and `kubectl_pod_diagnostics` fix in place, a full run
against the reference environment no longer hits rate limits, but a
realistic diagnosis (pod status + datasource discovery + log label discovery
+ log queries + metric queries) can legitimately need more than a handful of
tool calls — especially when the model has to recover from a wrong first
guess. Two things were found and addressed:

1. **`find_error_pattern_logs` / `find_slow_requests` fail outright** in the
   reference environment (`404 Plugin not found`). These are Grafana's
   "Sift" diagnostic tools, and Sift is a Grafana Cloud-only feature — its
   ML analysis runs on Grafana Cloud's backend, so a self-hosted OSS
   Grafana instance has no access to it regardless of local plugin
   configuration. This is a structural limitation of self-hosted
   deployments, not a missing local install, so both tools are excluded
   from `MCP_GRAFANA_TOOL_ALLOWLIST` in `.env.example` for good, with a
   comment explaining why.
2. **Two further recoverable mistakes cost iterations**: passing a relative
   time expression (`now-30m`) where the tool expects RFC3339, and guessing
   Loki label names/values before checking what actually exists. Neither is
   a code bug — the model recovered from both on its own — but they burn
   through the iteration budget. `agent_core/incident.py`'s
   `build_system_prompt()` now states the RFC3339 requirement and the
   "check labels before guessing" rule explicitly, and
   `AGENT_MAX_ITERATIONS` was raised from 8 to 12 to give a multi-source
   diagnosis realistic room even when a guess is wrong once.
3. **Reaching the iteration limit no longer discards partial findings.**
   Previously `AgentLoop` just appended a generic "gave up" message when the
   budget ran out — throwing away real signal already gathered (e.g. "both
   checkout pods are healthy, restart_count=0" rules out a whole class of
   causes). It now makes one additional call with no tools offered, asking
   the model to summarize its best-effort diagnosis from what is already in
   the conversation, and uses that as the final answer. If that call also
   fails, the original generic message is still the fallback.

## From a fixed question to alert-driven diagnosis

The original demo always asked a hardcoded question about checkout errors.
That's a reasonable smoke test, but it doesn't match the thesis's premise:
the agent is meant to react to alerts coming from the monitoring stack, not
to a question typed by a human. Two related problems came up while closing
that gap:

1. **`list_alert_groups` / `get_alert_group` were the wrong tools.** Despite
   the name, those are Grafana **OnCall** (on-call scheduling/escalation)
   tools, not firing alert rules — and this reference environment has no
   OnCall setup, so they would always return nothing useful. The tool that
   actually reports firing alerts is `alerting_manage_rules` (called with
   `operation: "list", states: ["firing"]`); it also supports
   create/update/delete, but the `mcp-grafana` docs confirm that with
   `--disable-write` on the server it automatically switches to a read-only
   mode with destructive operations hidden, so it's safe to expose. The
   allowlist in `.env.example` was updated accordingly, and the system
   prompt (guideline 6 in `incident.py`) tells the model explicitly to only
   ever use it to list alerts.
2. **The "current time" bug found during validation is now fixed at the
   root.** A previous run showed the model inferring "now" from a pod's
   `start_time` (the only concrete timestamp it happened to see in the
   conversation) and querying Prometheus for a 6-day-old time window as a
   result — half the iteration budget was wasted circling that mistake.
   `agent_core/incident.py::build_system_prompt()` now states the actual
   current UTC time directly in the system prompt, so the model has a real
   anchor instead of having to infer one from unrelated data.

`main.py` now runs as a continuous polling loop by default (`run_continuously`
in main.py): every `AGENT_POLL_INTERVAL_SECONDS` it calls the alerting tool
for currently firing alerts (`fetch_firing_alerts_raw`), and starts a fresh
investigation only when the firing set actually changed since the last one
(`agent_core/incident.py::alerts_signature`) — so an alert that stays firing
across many poll cycles produces exactly one investigation, not one per
cycle. A single-shot mode (`AGENT_RUN_ONCE=true`, `run_once` in main.py) is
still available for quick smoke tests: one investigation from whatever is
firing right now, or the static example question if nothing is, then exit.
The alert-fetching, signature, and prompt-building logic all live in
`agent_core/incident.py` as plain functions with no I/O, specifically so
they're unit-testable without a live LLM or MCP server — `main.py` only
wires them to the actual tool calls and the poll loop.

## Push instead of polling: `webhook_server.py`

Polling has two costs: latency (up to `AGENT_POLL_INTERVAL_SECONDS` between
an alert firing and the investigation starting) and waste (querying the
alerting tool on a schedule even when nothing has changed for hours).
Grafana/Alertmanager don't expose a websocket for "an alert just fired" —
the actual push mechanism in this ecosystem is a **webhook**: Alertmanager
POSTs a JSON payload to a receiver URL the moment an alert group starts or
stops firing, the same way it would notify Slack or PagerDuty. This is also
literally the architecture already named in the thesis's own role split
("Alert → Webhook → Agent", owned by the Integration and Communication
Interface component) — `webhook_server.py` implements the agent side of
that contract.

### Where the alerts come from now — this matters, read carefully

This reference infrastructure actually has **two independent alerting
subsystems**, and the polling path and the webhook path pull from
different ones:

- **Polling (`main.py`, via `alerting_manage_rules`)** reads **Grafana-managed
  alert rules** — rules created and evaluated inside Grafana itself, exposed
  through Grafana's own alerting API. `kube-prometheus-stack` (which this
  reference environment is built on) does not create any Grafana-managed
  rules by default, so unless someone manually added one in the Grafana UI,
  this list is very likely to be **empty on this environment**, independent
  of whether anything is actually wrong in the cluster.
- **Webhook (`webhook_server.py`)** receives whatever Alertmanager decides
  to send — and Alertmanager's alerts come from **`PrometheusRule` objects
  evaluated by Prometheus itself** (the `kube-prometheus-stack` Helm chart
  ships several of these out of the box, e.g. `Watchdog`, pod
  crash-looping, node pressure, and more), routed through Alertmanager
  (reachable at `http://localhost:9093` per the infrastructure's own
  README) and pushed out via its configured receivers.

In other words, switching to the webhook isn't just a latency/efficiency
improvement — it's very likely fixing a **correctness gap**: the polling
path may have been asking an alerting engine that has nothing configured in
it, while the alerts that actually reflect the state of this cluster live
in Prometheus/Alertmanager and were never being read at all. Worth
confirming directly against your own environment (check whether Grafana's
Alerting UI has any rules defined) rather than taking this as certain for
every deployment of the reference infrastructure — but it's the more likely
explanation than "the cluster has simply been healthy every time we
checked."

### Running it

```bash
export LLM_PROVIDER=openai
export OPENAI_API_KEY=...
uvicorn webhook_server:app --host 0.0.0.0 --port 8090
```

### Wiring Alertmanager to call it

This is a change to the infrastructure component's Helm values (e.g.
`values/prom-values.yaml`), since it's Alertmanager configuration, not
agent code:

```yaml
alertmanager:
  alertmanagerSpec:
    # See "Networking" below — required to make host.docker.internal
    # resolve inside the Alertmanager pod on Docker Desktop.
    hostAliases:
      - ip: "<see below>"
        hostnames:
          - "host.docker.internal"
  config:
    global:
      resolve_timeout: 5m
    route:
      receiver: agent-webhook
      group_by: ['namespace', 'alertname']
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        # CRITICAL: kube-prometheus-stack's default alertmanager config
        # routes the always-firing "Watchdog" heartbeat alert (and
        # "InfoInhibitor") to a null receiver — setting alertmanager.config
        # at all REPLACES that default wholesale, not merges with it. Omit
        # this and the webhook gets a "firing" call for Watchdog forever,
        # roughly every group_interval, for an alert that means nothing is
        # wrong.
        - receiver: "null"
          matchers:
            - alertname =~ "InfoInhibitor|Watchdog"
    receivers:
      - name: "null"
      - name: agent-webhook
        webhook_configs:
          - url: http://host.docker.internal:8080/alerts/webhook
            send_resolved: true
            http_config:
              authorization:
                credentials: <same value as WEBHOOK_SHARED_SECRET in .env>
```

### Networking

`host.docker.internal` is **not** guaranteed to resolve from inside a
Kubernetes pod, even on Docker Desktop — that hostname is reliably
available to plain `docker run` containers, but pod DNS goes through
CoreDNS, which doesn't know it by default (this is a common source of
`NXDOMAIN` in exactly this setup). Find the actual host-gateway IP with:

```bash
docker run --rm alpine getent hosts host.docker.internal
```

and put that IP in the `hostAliases` entry above instead of relying on DNS
resolution. If that IP changes across Docker Desktop restarts and this
becomes too fragile to demo reliably, falling back to `main.py`'s polling
mode for local development is entirely reasonable — this networking wrinkle
is specific to "webhook receiver runs on the host, Alertmanager runs in a
local Docker Desktop cluster." On a real cluster it doesn't come up at all:
deploy `webhook_server.py` as a Service inside the same cluster and point
the receiver at ordinary in-cluster DNS
(`http://agent-webhook.default.svc.cluster.local:8080/alerts/webhook`) —
one line to change, same as `MCP_GRAFANA_URL`.

### Why an alert storm doesn't translate into a pile of concurrent investigations

Two layers of protection, deliberately at different levels:

1. **Alertmanager's own grouping does most of the work before we ever see
   anything.** `group_by`/`group_wait`/`group_interval` mean that several
   alert rules tripping from the same root cause (e.g. a bad deploy
   triggering error-rate, latency, and restart-count alerts together)
   typically arrive as **one** webhook call containing the whole group, not
   one call per rule. This is the same problem `alerts_signature()` was
   approximating for the polling path — here it's handled upstream, by the
   tool designed for exactly this.
2. **`webhook_server.py` still serializes investigations of its own
   accord**, because grouping doesn't prevent two *different* groups (e.g.
   `checkout` and `payment`) from firing within seconds of each other. The
   handler never runs `AgentLoop` inline — it validates the payload and
   pushes the resulting incident description onto an `asyncio.Queue`,
   returning immediately. A single background worker task consumes that
   queue one item at a time, so at most one investigation — and one
   provider/token budget — is ever in flight, regardless of how many
   webhook calls land close together. Extra ones simply wait their turn
   instead of running concurrently and multiplying the rate-limit risk
   already seen earlier in this document.

### Recommended setup: push as primary, polling as reconciliation

Run both. Set `AGENT_POLL_INTERVAL_SECONDS` to something much longer (e.g.
300s+) when `webhook_server.py` is also running, so polling stops being the
primary trigger and becomes a safety net that catches whatever the webhook
missed (a restart, a transient network issue) — a standard resilience
pattern in event-driven systems ("push as the fast path, poll as
reconciliation"), rather than trusting a single delivery mechanism
completely.

## Saving diagnosis reports to disk

The agent's final answer, as produced by `AgentLoop`, is free text — good
for a human reading the transcript, but not something another program can
reliably act on later. `agent_core/report.py` adds a step after the
investigation finishes: it asks the LLM (one more call, no tools offered,
separate from the investigation itself) to restructure its own diagnosis
into a fixed shape, and saves the result as a JSON file.

Every report has exactly these fields:

```json
{
  "generated_at": "2026-07-18T14:30:00Z",
  "title": "Checkout failing due to payment service timeouts",
  "error_sources": [
    "checkout pod logs (namespace otel-demo)",
    "payment error-rate metric (query_prometheus)"
  ],
  "problem": "The payment service is timing out under load, causing checkout requests to fail.",
  "remediations": [
    "Scale the payment deployment",
    "Investigate why payment's downstream dependency is slow"
  ],
  "raw_diagnosis": "<the original, full free-text diagnosis, kept verbatim>"
}
```

`raw_diagnosis` is always included, even when structuring goes perfectly —
nothing is thrown away in favour of the structured fields, so the original
reasoning stays inspectable. If the structuring call itself fails to
produce valid JSON (or fails outright, e.g. a rate limit), `parse_report_json`
falls back to `title: "Untitled incident report"` and `problem` set to the
raw diagnosis text, rather than losing the finding entirely — the report
degrades to "less structured", never to "missing".

Reports land in `REPORT_OUTPUT_DIR` (default `./reports`, created
automatically if missing), one file per investigation, named
`<UTC timestamp>-report.json` so concurrent or repeated runs never collide
or overwrite each other. Both `main.py` and `webhook_server.py` save a
report after every investigation — this is currently local disk only, as
requested; shipping reports somewhere else (a database, an S3-like bucket,
a dashboard) would be a separate, later integration point, not a change to
`report.py` itself, since `save_report()`'s only job is "write this dict to
a path".

## Logging

Log output was originally dominated by `httpx`'s one-line-per-request
chatter (SSE messages, retries, ...), which buried the agent's own
decisions. `main.py` now sets third-party loggers (`httpx`, `openai`, `mcp`)
to `WARNING`, so their output only shows up when something is actually
wrong. `AgentLoop` itself now logs:

- a start line with the iteration budget and number of tools available,
- per-tool-call outcome (not just failures) with elapsed time and result
  size, so a slow or unexpectedly large tool call is visible without
  reading the full transcript,
- a finish line with total elapsed time, whether the model produced a
  final answer directly or the wrap-up path was needed, and how many
  messages ended up in the transcript.

## Security / design decisions

- The `mcp-grafana` server used for validation runs with
  `--disable-write: true` — the agent cannot modify anything in
  Grafana/Prometheus/Loki, consistent with the thesis assumption that the
  system only supports decisions.
- The `kubectl_*` tools enforce a hard timeout and an optional namespace
  allowlist (`KUBECTL_ALLOWED_NAMESPACES`) — they never execute an arbitrary
  shell command, only specific, predetermined ones.
- `KubectlPodDiagnosticsTool` queries `kubectl get pod/events -o json` rather
  than parsing free-text `describe` output, and reduces the result to
  diagnosis-relevant fields only (phase, restart/crash state, unhealthy
  conditions, recent warning events). This keeps tool output compact and
  predictable for both token-budget and prompt-quality reasons, instead of
  relying on character-count truncation of a much larger free-text blob.
- `ToolResult` always returns a `{success, data, error}` structure regardless
  of the tool's source, so the LLM receives a consistent context format.

## Integration points for the rest of the team

- **RAG component**: implement a `Tool` with an
  `execute(query: str) -> ToolResult` method and register it in
  `ToolRegistry` — the agent will start using it without any changes to
  `AgentLoop`.
- **Slack interface**: the alert intake and investigation are now handled
  by `webhook_server.py`, and every finished investigation is saved as a
  structured JSON report under `REPORT_OUTPUT_DIR` (see "Saving diagnosis
  reports to disk") — `title` and `problem` alone are already close to a
  postable Slack message, with `error_sources`/`remediations` as bullet
  lists. Posting that to Slack (formatting, threading per incident, etc.)
  is the next piece for this component; the cleanest hook is probably
  reading the freshly-written JSON file (or receiving its path/content via
  a callback passed into the worker) rather than re-deriving the report,
  so `webhook_server.py` stays about running investigations, not about
  chat formatting.
- **Infrastructure component**: the only environment dependency for the MCP
  path is `MCP_GRAFANA_URL` — if the address/port changes (e.g. moving from
  local port forwarding to a Service inside the cluster), updating it is a
  single line in `.env`. The webhook path additionally needs the
  Alertmanager receiver config shown above added to the infra's Helm
  values, and a real, reachable URL for `webhook_server.py` once it's not
  just running on a developer's machine.
