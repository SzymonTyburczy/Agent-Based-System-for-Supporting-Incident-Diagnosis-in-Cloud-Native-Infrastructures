from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

import webhook_server as wh
from agent_core.config import Settings
from agent_core.incident import IncidentMeta

FIRING_PAYLOAD = {
    "version": "4",
    "status": "firing",
    "alerts": [
        {
            "status": "firing",
            "labels": {"alertname": "HighErrorRate", "namespace": "otel-demo"},
            "annotations": {"summary": "Checkout error rate above 5%"},
            "startsAt": "2026-07-18T10:00:00Z",
        }
    ],
}


@pytest.fixture
def client():
    # Same reasoning as test_reports_endpoints: skip `lifespan` (real infra)
    # and wire only what the webhook handler touches. A fresh queue per test
    # keeps items from leaking between tests via the module-level state.
    wh.state.settings = Settings(webhook_shared_secret=None)
    wh.state.queue = asyncio.Queue(maxsize=wh.ALERT_QUEUE_MAX_SIZE)
    return TestClient(wh.app)


def test_webhook_queues_firing_alert_when_secret_unset(client):
    response = client.post("/alerts/webhook", json=FIRING_PAYLOAD)

    assert response.status_code == 200
    assert response.json() == {"status": "queued"}
    assert wh.state.queue.qsize() == 1


def test_webhook_accepts_matching_secret(client):
    wh.state.settings.webhook_shared_secret = "s3cret"

    response = client.post(
        "/alerts/webhook", json=FIRING_PAYLOAD, headers={"Authorization": "Bearer s3cret"}
    )

    assert response.status_code == 200
    assert wh.state.queue.qsize() == 1


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong"},
        {"Authorization": "s3cret"},
        # Non-ASCII must still be a plain 401, not a 500 from compare_digest.
        {"Authorization": "Bearer zażółć".encode()},
    ],
)
def test_webhook_rejects_missing_or_wrong_secret(client, headers):
    wh.state.settings.webhook_shared_secret = "s3cret"

    response = client.post("/alerts/webhook", json=FIRING_PAYLOAD, headers=headers)

    assert response.status_code == 401
    assert wh.state.queue.empty()


def test_webhook_returns_503_and_does_not_enqueue_when_queue_is_full(client):
    wh.state.queue = asyncio.Queue(maxsize=1)
    already_queued = wh.QueuedIncident(
        description="earlier", meta=IncidentMeta(service="checkout", severity="critical")
    )
    wh.state.queue.put_nowait(already_queued)

    response = client.post("/alerts/webhook", json=FIRING_PAYLOAD)

    assert response.status_code == 503
    assert response.json() == {"detail": "investigation queue is full"}
    assert wh.state.queue.qsize() == 1
    assert wh.state.queue.get_nowait() is already_queued


def test_default_alert_queue_is_bounded():
    assert wh.AppState().queue.maxsize == wh.ALERT_QUEUE_MAX_SIZE > 0
