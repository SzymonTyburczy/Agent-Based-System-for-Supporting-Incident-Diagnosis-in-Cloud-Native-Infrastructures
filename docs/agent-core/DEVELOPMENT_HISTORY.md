# Agent development history

These notes preserve the implementation history and validation findings previously
mixed into the agent README. They are historical context, not current setup
instructions or a dated release changelog. Tool counts and provider limits below
refer to the environment used at the time.

For current behavior, see [architecture](../ARCHITECTURE.md); for commands, see
[the agent README](../../agent-core/README.md), [testing](../TESTING.md), and
[container deployment](../CONTAINERS.md).

## Initial implementation

The first milestones introduced a provider-independent agent loop, interchangeable
CLI and MCP tools, mock-based tests, working LLM providers, and integration with
the reference Grafana monitoring stack. OpenAI, Anthropic, and Ollama adapters
share the same provider interface. New diagnostic tools can be registered without
changing the loop.

## Validation: MCP tool count and rate limits

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

## Validation: iteration budget and partial findings

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

## Webhook intake and serialized investigations

The initial entry point polled Grafana-managed alert rules. The example stack also
uses Prometheus rules routed through Alertmanager; these are distinct alert sources.
The webhook receiver was added to consume Alertmanager notifications directly.

Alertmanager grouping reduces related notifications before delivery. The agent then
queues incidents and uses one worker to avoid concurrent investigations multiplying
provider load. Queue acceptance is separate from diagnosis completion.

The old README recommended polling as reconciliation alongside the webhook. This
is not a complete fallback in the current implementation: the paths query different
alert sources, have no shared deduplication, and polling does not populate the panel's
SQLite store. See the current architecture before choosing how to run them.

## Structured reports and the client API

The initial loop produced a free-text diagnosis. A separate LLM call was added to
structure it into title, summary, evidence sources, problem, and remediation fields.
The original diagnosis is retained; parsing failures fall back to a less structured
report instead of discarding the text.

JSON files were followed by a SQLite store for report IDs, service/severity metadata,
Markdown content, and mutable pending/resolved status. The webhook worker writes both
formats. The polling entry point still writes JSON only.

REST endpoints were added for listing reports, reading details, and changing status.
An in-process broadcaster and SSE endpoint were introduced for live client updates,
with separate client authentication and CORS settings. The current route-ordering
limitation is documented in [testing](../TESTING.md#5-check-live-updates-separately).

## Container validation

Local Docker validation exposed a missing MCP port forward and rejection of Docker
Desktop's Host header by the MCP server. A loopback-only tunnel and an explicit
local Host allowlist were added to support the container-to-host connection.

An unconstrained dependency installed MCP SDK 2.x, whose tool schema attributes
were incompatible with the adapter. The dependency now specifies `mcp>=1.2,<2`.
Runtime images include kubectl, run as a non-root user, and store persistent reports
under `/data` when the documented volume is mounted.
