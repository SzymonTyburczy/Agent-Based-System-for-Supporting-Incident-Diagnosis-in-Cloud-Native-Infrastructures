from __future__ import annotations

from datetime import datetime, timezone

from agent_core.incident import (
    alerts_signature,
    build_incident_description,
    build_incident_description_from_webhook,
    build_system_prompt,
    extract_incident_meta_from_webhook,
    summarize_firing_alerts,
)


def test_build_system_prompt_includes_given_time():
    fixed_time = datetime(2026, 7, 18, 10, 30, 0, tzinfo=timezone.utc)

    prompt = build_system_prompt(now=fixed_time)

    assert "2026-07-18T10:30:00Z" in prompt
    assert "never infer the current time" in prompt


def test_build_system_prompt_defaults_to_real_current_time():
    before = datetime.now(timezone.utc)
    prompt = build_system_prompt()
    after = datetime.now(timezone.utc)

    # the year in the rendered prompt must fall within the call window
    assert str(before.year) in prompt or str(after.year) in prompt


def test_summarize_firing_alerts_returns_none_for_empty_variants():
    for empty in (None, "", "   ", "[]", "{}", "null", "None"):
        assert summarize_firing_alerts(empty) is None


def test_summarize_firing_alerts_returns_text_when_present():
    raw = '[{"title": "HighErrorRate", "state": "firing"}]'
    assert summarize_firing_alerts(raw) == raw


def test_build_incident_description_falls_back_when_no_alerts():
    fallback = "Diagnose checkout errors."

    description = build_incident_description(None, fallback)

    assert description == fallback


def test_build_incident_description_uses_alert_data_when_present():
    fallback = "Diagnose checkout errors."
    alerts_raw = '[{"title": "HighErrorRate", "state": "firing", "labels": {"pod": "checkout"}}]'

    description = build_incident_description(alerts_raw, fallback)

    assert description != fallback
    assert alerts_raw in description
    assert "currently firing" in description
    assert "alert labels/annotations" in description


def test_alerts_signature_is_none_when_nothing_firing():
    for empty in (None, "", "[]", "{}", "null"):
        assert alerts_signature(empty) is None


def test_alerts_signature_is_stable_for_identical_input():
    alerts_raw = '[{"title": "HighErrorRate", "state": "firing"}]'

    assert alerts_signature(alerts_raw) == alerts_signature(alerts_raw)


def test_alerts_signature_changes_when_alerts_change():
    first = '[{"title": "HighErrorRate", "state": "firing"}]'
    second = '[{"title": "HighErrorRate", "state": "firing"}, {"title": "OOMKilled", "state": "firing"}]'

    assert alerts_signature(first) != alerts_signature(second)


def test_alerts_signature_ignores_surrounding_whitespace():
    assert alerts_signature("  [1]  ") == alerts_signature("[1]")


def _webhook_payload(**overrides):
    base = {
        "version": "4",
        "status": "firing",
        "groupLabels": {"alertname": "HighErrorRate", "namespace": "otel-demo"},
        "alerts": [
            {
                "status": "firing",
                "labels": {"alertname": "HighErrorRate", "namespace": "otel-demo", "pod": "checkout-1"},
                "annotations": {"summary": "Checkout error rate above 5%"},
                "startsAt": "2026-07-18T10:00:00Z",
            }
        ],
    }
    base.update(overrides)
    return base


def test_webhook_builds_description_for_firing_payload():
    description = build_incident_description_from_webhook(_webhook_payload())

    assert description is not None
    assert "HighErrorRate" in description
    assert "Checkout error rate above 5%" in description
    assert "2026-07-18T10:00:00Z" in description
    assert "namespace=otel-demo" in description


def test_webhook_returns_none_for_resolved_status():
    payload = _webhook_payload(status="resolved")
    assert build_incident_description_from_webhook(payload) is None


def test_webhook_returns_none_when_no_alerts_are_actually_firing():
    payload = _webhook_payload(alerts=[{"status": "resolved", "labels": {}, "annotations": {}}])
    assert build_incident_description_from_webhook(payload) is None


def test_webhook_returns_none_for_malformed_payload():
    assert build_incident_description_from_webhook({}) is None
    assert build_incident_description_from_webhook({"status": "firing"}) is None
    assert build_incident_description_from_webhook({"status": "firing", "alerts": "not-a-list"}) is None
    assert build_incident_description_from_webhook("not-a-dict") is None  # type: ignore[arg-type]


def test_webhook_includes_all_firing_alerts_in_a_group():
    payload = _webhook_payload(
        alerts=[
            {
                "status": "firing",
                "labels": {"alertname": "HighErrorRate", "pod": "checkout-1"},
                "annotations": {},
                "startsAt": "2026-07-18T10:00:00Z",
            },
            {
                "status": "firing",
                "labels": {"alertname": "HighLatency", "pod": "checkout-2"},
                "annotations": {},
                "startsAt": "2026-07-18T10:01:00Z",
            },
        ]
    )

    description = build_incident_description_from_webhook(payload)

    assert "HighErrorRate" in description
    assert "HighLatency" in description
    assert "2 firing alert(s)" in description


# --- extract_incident_meta_from_webhook ----------------------------------


def test_extract_meta_prefers_group_labels():
    payload = _webhook_payload(
        groupLabels={"alertname": "HighErrorRate", "service": "checkout-service", "severity": "critical"}
    )

    meta = extract_incident_meta_from_webhook(payload)

    assert meta.service == "checkout-service"
    assert meta.severity == "critical"


def test_extract_meta_falls_back_to_first_alert_labels():
    payload = _webhook_payload(
        groupLabels={"alertname": "HighErrorRate"},
        alerts=[
            {
                "status": "firing",
                "labels": {"alertname": "HighErrorRate", "service": "payment-service", "severity": "warning"},
                "annotations": {},
                "startsAt": "2026-07-18T10:00:00Z",
            }
        ],
    )

    meta = extract_incident_meta_from_webhook(payload)

    assert meta.service == "payment-service"
    assert meta.severity == "warning"


def test_extract_meta_falls_back_through_service_label_candidates():
    payload = _webhook_payload(
        groupLabels={"alertname": "KubeControllerManagerDown", "job": "kube-controller-manager"}
    )

    meta = extract_incident_meta_from_webhook(payload)

    assert meta.service == "kube-controller-manager"


def test_extract_meta_defaults_to_unknown_when_labels_absent():
    payload = _webhook_payload(groupLabels={"alertname": "HighErrorRate"}, alerts=[
        {"status": "firing", "labels": {"alertname": "HighErrorRate"}, "annotations": {}, "startsAt": "now"}
    ])

    meta = extract_incident_meta_from_webhook(payload)

    assert meta.service == "unknown"
    assert meta.severity == "unknown"


def test_extract_meta_handles_malformed_payload():
    meta = extract_incident_meta_from_webhook("not-a-dict")  # type: ignore[arg-type]

    assert meta.service == "unknown"
    assert meta.severity == "unknown"
