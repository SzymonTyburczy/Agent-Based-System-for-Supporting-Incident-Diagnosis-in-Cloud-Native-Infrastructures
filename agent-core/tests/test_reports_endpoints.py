from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import webhook_server as wh
from agent_core.config import Settings
from agent_core.report_events import ReportEventBroadcaster
from agent_core.reports_store import ReportRecord, ReportsStore

CITATION = {
    "key": "KB1",
    "doc_id": "doc-1",
    "file_name": "pod-restarts.md",
    "title": "Pod restart runbook",
    "section_path": ["Pods", "Diagnosis"],
    "chunk_index": 0,
    "quote": "Check the previous container logs.",
}


def _record(**overrides) -> ReportRecord:
    base = dict(
        id="rep-1",
        generated_at="2026-07-18T14:30:00Z",
        title="Checkout errors",
        service="checkout-service",
        severity="critical",
        summary="Payments are timing out under load.",
        problem="The payment service is timing out under load.",
        error_sources=["checkout pod logs"],
        remediations=["Scale the payment deployment"],
        raw_diagnosis="full free-text diagnosis",
        content_md="# Checkout errors\n\nfull content",
    )
    base.update(overrides)
    return ReportRecord(**base)


@pytest.fixture
def client():
    # Deliberately not entering the app as a context manager: that would
    # trigger `lifespan` (MCP connection, LLM provider) which needs real
    # infra. These endpoints only touch `state.settings`/`state.reports_store`/
    # `state.broadcaster` directly, so wiring those by hand is enough.
    wh.state.settings = Settings(client_api_token=None)
    wh.state.reports_store = ReportsStore(":memory:")
    wh.state.broadcaster = ReportEventBroadcaster()
    return TestClient(wh.app)


def test_list_reports_returns_summaries_without_detail_fields(client):
    wh.state.reports_store.insert(_record())

    response = client.get("/reports")

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["id"] == "rep-1"
    assert body[0]["title"] == "Checkout errors"
    assert "content_md" not in body[0]
    assert "raw_diagnosis" not in body[0]


def test_list_reports_filters_by_status(client):
    wh.state.reports_store.insert(_record(id="rep-pending"))
    wh.state.reports_store.insert(_record(id="rep-resolved", status="resolved"))

    response = client.get("/reports", params={"status": "resolved"})

    body = response.json()
    assert [r["id"] for r in body] == ["rep-resolved"]


def test_get_report_returns_full_detail(client):
    wh.state.reports_store.insert(_record())

    response = client.get("/reports/rep-1")

    assert response.status_code == 200
    body = response.json()
    assert body["content_md"] == "# Checkout errors\n\nfull content"
    assert body["error_sources"] == ["checkout pod logs"]


def test_get_report_includes_citations_but_list_does_not(client):
    wh.state.reports_store.insert(_record(citations=[CITATION]))

    detail = client.get("/reports/rep-1").json()
    summaries = client.get("/reports").json()

    assert detail["citations"] == [CITATION]
    assert "citations" not in summaries[0]


def test_get_report_404_for_unknown_id(client):
    response = client.get("/reports/does-not-exist")
    assert response.status_code == 404


def test_patch_report_status_updates_and_returns_detail(client):
    wh.state.reports_store.insert(_record())

    response = client.patch("/reports/rep-1", json={"status": "resolved"})

    assert response.status_code == 200
    assert response.json()["status"] == "resolved"
    assert wh.state.reports_store.get("rep-1").status == "resolved"


def test_patch_report_status_404_for_unknown_id(client):
    response = client.patch("/reports/does-not-exist", json={"status": "resolved"})
    assert response.status_code == 404


def test_patch_report_status_rejects_invalid_status(client):
    wh.state.reports_store.insert(_record())

    response = client.patch("/reports/rep-1", json={"status": "archived"})

    assert response.status_code == 422


def test_reports_endpoints_require_token_when_configured(client):
    wh.state.settings.client_api_token = "secret"

    unauthorized = client.get("/reports")
    assert unauthorized.status_code == 401

    authorized = client.get("/reports", headers={"Authorization": "Bearer secret"})
    assert authorized.status_code == 200


def test_reports_endpoints_allow_any_caller_when_token_unset(client):
    assert wh.state.settings.client_api_token is None
    response = client.get("/reports")
    assert response.status_code == 200


def test_reports_endpoints_accept_token_as_query_param(client):
    # EventSource (used for the SSE stream) can't set custom headers, so
    # the token may travel as ?token= instead — see require_client_token.
    wh.state.settings.client_api_token = "secret"

    response = client.get("/reports", params={"token": "secret"})
    assert response.status_code == 200

    wrong = client.get("/reports", params={"token": "nope"})
    assert wrong.status_code == 401


def test_reports_stream_is_not_shadowed_by_report_detail_route(client, monkeypatch):
    # /reports/stream must resolve to the SSE endpoint, not to
    # GET /reports/{report_id} with report_id="stream" (which answers 404).
    # The stream itself never ends, so report the client as disconnected:
    # the generator then stops right after its initial ": connected" frame.
    async def disconnected(self) -> bool:
        return True

    monkeypatch.setattr(wh.Request, "is_disconnected", disconnected)

    response = client.get("/reports/stream")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text == ": connected\n\n"
    assert wh.state.broadcaster.subscriber_count == 0
