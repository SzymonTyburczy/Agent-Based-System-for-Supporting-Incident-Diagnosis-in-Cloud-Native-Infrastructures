from __future__ import annotations

from agent_core.tools.cli_tools import (
    MAX_OUTPUT_CHARS,
    _truncate,
    summarize_events,
    summarize_pod,
)


def test_truncate_leaves_short_text_untouched():
    text = "pod is Running, 0 restarts"
    assert _truncate(text) == text


def test_truncate_caps_long_text_and_reports_omitted_count():
    text = "x" * (MAX_OUTPUT_CHARS + 500)

    result = _truncate(text)

    assert result.startswith("x" * MAX_OUTPUT_CHARS)
    assert "500 more characters omitted" in result
    assert len(result) < len(text)


def test_summarize_pod_surfaces_oomkilled_container():
    """Mirrors the real 'load-generator' pod from the OTel demo: OOMKilled,
    2 restarts. This is exactly the kind of signal that must survive
    filtering — env vars and volume mounts should not.
    """
    pod_json = {
        "metadata": {"name": "load-generator-5765f7695c-tbstm", "namespace": "otel-demo"},
        "status": {
            "phase": "Running",
            "startTime": "2026-07-13T01:19:56Z",
            "containerStatuses": [
                {
                    "name": "load-generator",
                    "ready": False,
                    "restartCount": 2,
                    "state": {"waiting": {"reason": "CrashLoopBackOff", "message": "back-off restarting"}},
                    "lastState": {
                        "terminated": {"reason": "OOMKilled", "exitCode": 137}
                    },
                }
            ],
            "conditions": [
                {"type": "Ready", "status": "False", "reason": "ContainersNotReady"},
                {"type": "PodScheduled", "status": "True"},
            ],
        },
    }

    summary = summarize_pod(pod_json)

    assert summary["pod"] == "load-generator-5765f7695c-tbstm"
    assert summary["phase"] == "Running"

    container = summary["containers"][0]
    assert container["restart_count"] == 2
    assert container["state"] == "waiting"
    assert container["reason"] == "CrashLoopBackOff"
    assert container["previous_termination_reason"] == "OOMKilled"
    assert container["previous_exit_code"] == 137

    # Ready=True condition is not a problem, so it must be filtered out;
    # only the unhealthy one should remain.
    assert len(summary["unhealthy_conditions"]) == 1
    assert summary["unhealthy_conditions"][0]["type"] == "Ready"


def test_summarize_pod_healthy_container_has_no_reason_fields():
    pod_json = {
        "metadata": {"name": "checkout-798c8f47cd-24lsr", "namespace": "otel-demo"},
        "status": {
            "phase": "Running",
            "containerStatuses": [
                {"name": "checkout", "ready": True, "restartCount": 0, "state": {"running": {}}}
            ],
            "conditions": [{"type": "Ready", "status": "True"}],
        },
    }

    summary = summarize_pod(pod_json)

    container = summary["containers"][0]
    assert container["state"] == "running"
    assert "reason" not in container
    assert summary["unhealthy_conditions"] == []


def test_summarize_events_keeps_only_warnings_and_sorts_by_recency():
    events = [
        {"type": "Normal", "reason": "Pulled", "lastTimestamp": "2026-07-18T10:00:00Z"},
        {
            "type": "Warning",
            "reason": "BackOff",
            "message": "Back-off restarting failed container",
            "count": 3,
            "lastTimestamp": "2026-07-18T12:00:00Z",
        },
        {
            "type": "Warning",
            "reason": "OOMKilling",
            "message": "Memory cgroup out of memory",
            "count": 1,
            "lastTimestamp": "2026-07-18T11:00:00Z",
        },
    ]

    result = summarize_events(events)

    assert len(result) == 2  # the Normal event is dropped
    assert result[0]["reason"] == "BackOff"  # most recent first
    assert result[1]["reason"] == "OOMKilling"


def test_summarize_events_respects_limit():
    events = [
        {"type": "Warning", "reason": f"Reason{i}", "lastTimestamp": f"2026-07-18T{i:02d}:00:00Z"}
        for i in range(10)
    ]

    result = summarize_events(events, limit=3)

    assert len(result) == 3
