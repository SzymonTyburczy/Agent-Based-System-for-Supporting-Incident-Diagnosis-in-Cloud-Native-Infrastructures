"""Turns live signals (current time, firing alerts) into the system prompt
and incident description handed to the agent loop.

Kept separate from main.py, as pure functions, so this logic is unit
testable without a live LLM provider or a running MCP server — the
orchestration (actually calling tools) stays a thin wrapper in main.py.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

SYSTEM_PROMPT_TEMPLATE = (
    "You are an SRE diagnostic agent for a Kubernetes cluster running the "
    "OpenTelemetry Demo Store. You have access to tools that query telemetry "
    "(Prometheus, Loki) through a Grafana MCP server running in read-only "
    "mode, as well as kubectl tools (also read-only).\n\n"
    "Current UTC time: {now}. Use this as your reference point for relative "
    "time windows (e.g. \"the last 30 minutes\") — never infer the current "
    "time from an unrelated timestamp such as a pod's start time.\n\n"
    "Guidelines:\n"
    "1. Gather data (metrics, logs, pod status) instead of guessing.\n"
    "2. Before querying Loki or Prometheus with a label selector, first "
    "check which labels and values actually exist (e.g. "
    "list_prometheus_label_values, list_loki_label_values) instead of "
    "guessing label names such as 'app' or 'pod'.\n"
    "3. Always pass absolute timestamps in RFC3339 format (e.g. "
    "'2026-07-18T10:00:00Z'), never relative expressions like 'now' or "
    "'now-30m' — the tools reject those.\n"
    "4. Check both logs AND metrics (e.g. query_prometheus for error rate "
    "or latency) before concluding — healthy pod status alone does not "
    "rule out an upstream dependency or a metrics-visible problem.\n"
    "5. If a tool call fails outright (e.g. 'Plugin not found'), do not "
    "retry the same tool — treat it as unavailable in this environment and "
    "continue with a different one.\n"
    "6. The alerting tool can list and modify alert rules, but only ever "
    "use it to list firing/pending alerts — never create, update, or "
    "delete a rule.\n"
    "7. Reply with a short report: probable root cause + suggested "
    "remediation steps, noting any remaining uncertainty. Never suggest or "
    "attempt actions that modify the infrastructure — your role is "
    "decision support only."
)

INCIDENT_FROM_ALERTS_TEMPLATE = (
    "The following alert rule(s) are currently firing in Grafana (raw data "
    "from the alerting tool):\n\n"
    "{alerts}\n\n"
    "Diagnose the root cause of the underlying incident, using the alert "
    "labels/annotations as your starting point, and confirm your hypothesis "
    "with pod status, logs, and metrics."
)


def build_system_prompt(now: datetime | None = None) -> str:
    """Renders the system prompt with the current UTC time filled in.

    `now` is injectable for tests; defaults to the real current time.
    """
    now = now or datetime.now(timezone.utc)
    return SYSTEM_PROMPT_TEMPLATE.format(now=now.strftime("%Y-%m-%dT%H:%M:%SZ"))


def summarize_firing_alerts(raw_text: str | None) -> str | None:
    """Decides whether a raw tool result from the alerting tool represents
    any actual firing alerts, and if so returns it as-is for use as
    incident context. Returns None for empty/absent results so the caller
    can fall back to a different incident description.

    Deliberately does not parse the JSON into a strict schema: the exact
    shape returned by the MCP alerting tool is not something this project
    controls, and the LLM is well suited to interpreting semi-structured
    JSON directly. This function only answers "is there anything here
    worth acting on".
    """
    if raw_text is None:
        return None
    text = raw_text.strip()
    if not text or text in ("[]", "{}", "null", "None"):
        return None
    return text


def build_incident_description(alerts_raw: str | None, fallback_question: str) -> str:
    """Builds the user-facing incident description: live alert data if any
    firing alerts were found, otherwise the given fallback question.
    """
    alerts_summary = summarize_firing_alerts(alerts_raw)
    if alerts_summary is None:
        return fallback_question
    return INCIDENT_FROM_ALERTS_TEMPLATE.format(alerts=alerts_summary)


def alerts_signature(alerts_raw: str | None) -> str | None:
    """Returns a stable signature for a raw alerting-tool result, or None if
    it represents "nothing firing" (see `summarize_firing_alerts`).

    Used by the polling loop in `main.py` to avoid starting a fresh
    investigation on every poll cycle while the same alert is still firing
    — only a change in this signature (a new alert starts, an existing one
    clears, labels/annotations change) triggers a new run. This compares
    the whole payload rather than tracking individual alert identities,
    because the exact JSON shape returned by the MCP alerting tool isn't
    something this project controls (see `summarize_firing_alerts`); a
    whole-payload hash is simple and correct as long as the tool doesn't
    reorder unchanged results between calls.
    """
    alerts = summarize_firing_alerts(alerts_raw)
    if alerts is None:
        return None
    return hashlib.sha256(alerts.encode("utf-8")).hexdigest()


def build_incident_description_from_webhook(payload: dict) -> str | None:
    """Builds an incident description directly from an Alertmanager webhook
    payload (https://prometheus.io/docs/alerting/latest/configuration/#webhook_config).

    Unlike `build_incident_description` (which treats the MCP alerting
    tool's result as an opaque blob, because that schema isn't something
    this project controls), Alertmanager's webhook payload has a stable,
    documented shape, so this extracts specific fields (alert name, labels,
    annotations, start time) into a readable summary instead of dumping
    raw JSON at the model.

    Returns None for anything not worth starting an investigation over:
    a non-dict payload, a "resolved" notification (status != "firing"), or
    a firing notification with no actually-firing alerts in it (Alertmanager
    groups can technically contain a mix, e.g. right at a group boundary).
    """
    if not isinstance(payload, dict):
        return None
    if payload.get("status") != "firing":
        return None

    alerts = payload.get("alerts")
    if not isinstance(alerts, list):
        return None
    firing_alerts = [a for a in alerts if isinstance(a, dict) and a.get("status") == "firing"]
    if not firing_alerts:
        return None

    group_labels = payload.get("groupLabels") or {}
    lines = [
        f"Alertmanager reports {len(firing_alerts)} firing alert(s) "
        f"in group {group_labels or '(ungrouped)'}:"
    ]
    for alert in firing_alerts:
        labels = alert.get("labels") or {}
        annotations = alert.get("annotations") or {}
        name = labels.get("alertname", "unknown alert")
        starts_at = alert.get("startsAt", "unknown time")
        summary = annotations.get("summary") or annotations.get("description") or ""
        other_labels = ", ".join(f"{k}={v}" for k, v in labels.items() if k != "alertname")
        lines.append(f"- {name} (since {starts_at}): {summary} [{other_labels}]")

    return INCIDENT_FROM_ALERTS_TEMPLATE.format(alerts="\n".join(lines))
