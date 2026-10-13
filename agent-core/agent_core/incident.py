"""Turns firing alerts into the incident description handed to the agent
loop. The system prompt is composed in prompting.py (re-exported here).

Kept separate from main.py, as pure functions, so this logic is unit
testable without a live LLM provider or a running MCP server — the
orchestration (actually calling tools) stays a thin wrapper in main.py.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

from agent_core.prompting import build_system_prompt, load, render  # re-exports build_system_prompt

# alertname already leads each alert line; prometheus/prometheus_replica are
# Prometheus external labels that say nothing about the incident.
_NOISE_LABELS = frozenset({"alertname", "prometheus", "prometheus_replica"})


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
    return render(
        load("incident"),
        values={"source": "Grafana alerting (raw tool output)", "alerts": alerts_summary},
    )


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
    lines = [f"{len(firing_alerts)} firing alert(s) in group {_kv(group_labels) or '(ungrouped)'}:"]
    for alert in firing_alerts:
        labels = alert.get("labels") or {}
        annotations = alert.get("annotations") or {}
        name = labels.get("alertname", "unknown alert")
        starts_at = alert.get("startsAt", "unknown time")
        summary = annotations.get("summary") or annotations.get("description") or ""
        description = annotations.get("description") or ""
        line = f"- {name} (since {starts_at}): {summary}"
        if description and description != summary:
            line += f" — {description}"
        other_labels = _kv({k: v for k, v in labels.items() if k not in _NOISE_LABELS})
        if other_labels:
            line += f" [{other_labels}]"
        lines.append(line)
        # The alert's own PromQL tells the agent exactly which series fired,
        # instead of leaving it to guess metric names from the summary text.
        expr = _alert_expr(alert.get("generatorURL"))
        if expr:
            lines.append(f"  expr: {expr}")

    return render(load("incident"), values={"source": "Alertmanager", "alerts": "\n".join(lines)})


def _kv(labels: object) -> str:
    """Renders a label dict as "k=v, k=v" (a Python dict repr is noise to the model)."""
    if not isinstance(labels, dict):
        return ""
    return ", ".join(f"{k}={v}" for k, v in labels.items())


def _alert_expr(generator_url: object) -> str:
    """Decodes the alert expression from a Prometheus generatorURL
    (".../graph?g0.expr=...").
    """
    if not isinstance(generator_url, str):
        return ""
    values = parse_qs(urlsplit(generator_url).query).get("g0.expr")
    return values[0].strip()[:300] if values else ""


_UNKNOWN_LABEL = "unknown"

# Checked in order against groupLabels first, then the first firing alert's
# own labels — "service" is the ideal, explicit label, but this stack's
# alert rules don't all set it consistently, so we fall back through the
# labels that most often stand in for it (see the false-positive control-
# plane alerts noted in the thesis summary, which only carry `job`).
_SERVICE_LABEL_CANDIDATES = ("service", "job", "app", "app_kubernetes_io_name", "namespace")


@dataclass
class IncidentMeta:
    """Service/severity extracted from an Alertmanager webhook payload's own
    labels, carried alongside the free-text incident description so the
    reports store can tag a finished investigation without asking the LLM
    to restate labels it was already handed (and might not transcribe
    faithfully into its structured output).
    """

    service: str
    severity: str


def extract_incident_meta_from_webhook(payload: dict) -> IncidentMeta:
    """Best-effort extraction, not validation: call this only on a payload
    `build_incident_description_from_webhook` already accepted (status
    "firing" with at least one firing alert). Missing labels fall back to
    "unknown" rather than raising — a report worth saving shouldn't be
    dropped for a label a particular alert rule happens not to set.
    """
    if not isinstance(payload, dict):
        return IncidentMeta(service=_UNKNOWN_LABEL, severity=_UNKNOWN_LABEL)

    group_labels = payload.get("groupLabels")
    group_labels = group_labels if isinstance(group_labels, dict) else {}

    alerts = payload.get("alerts")
    first_alert_labels: dict = {}
    if isinstance(alerts, list):
        for alert in alerts:
            if isinstance(alert, dict) and isinstance(alert.get("labels"), dict):
                first_alert_labels = alert["labels"]
                break

    severity = group_labels.get("severity") or first_alert_labels.get("severity") or _UNKNOWN_LABEL

    service = _UNKNOWN_LABEL
    for key in _SERVICE_LABEL_CANDIDATES:
        value = group_labels.get(key) or first_alert_labels.get(key)
        if value:
            service = value
            break

    return IncidentMeta(service=service, severity=severity)
