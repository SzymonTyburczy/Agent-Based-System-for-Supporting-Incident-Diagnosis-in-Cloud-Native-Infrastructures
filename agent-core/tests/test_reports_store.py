from __future__ import annotations

import pytest

from agent_core.reports_store import ReportRecord, ReportsStore


def _record(**overrides) -> ReportRecord:
    base = dict(
        id="rep-1",
        generated_at="2026-07-18T14:30:00Z",
        title="Checkout errors",
        service="checkout-service",
        severity="critical",
        summary="Payment timeouts causing checkout failures.",
        problem="The payment service is timing out under load.",
        error_sources=["checkout pod logs"],
        remediations=["Scale the payment deployment"],
        raw_diagnosis="full free-text diagnosis",
        content_md="# Checkout errors\n\nfull content",
    )
    base.update(overrides)
    return ReportRecord(**base)


@pytest.fixture
def store() -> ReportsStore:
    store = ReportsStore(":memory:")
    yield store
    store.close()


def test_insert_and_get_round_trips_all_fields(store: ReportsStore):
    store.insert(_record())

    fetched = store.get("rep-1")

    assert fetched is not None
    assert fetched.title == "Checkout errors"
    assert fetched.service == "checkout-service"
    assert fetched.severity == "critical"
    assert fetched.status == "pending"
    assert fetched.error_sources == ["checkout pod logs"]
    assert fetched.remediations == ["Scale the payment deployment"]


def test_get_returns_none_for_unknown_id(store: ReportsStore):
    assert store.get("does-not-exist") is None


def test_new_record_defaults_to_pending_status():
    record = _record()
    assert record.status == "pending"


def test_record_rejects_invalid_status():
    with pytest.raises(ValueError):
        _record(status="archived")


def test_list_reports_orders_newest_first(store: ReportsStore):
    store.insert(_record(id="rep-old", generated_at="2026-07-18T10:00:00Z"))
    store.insert(_record(id="rep-new", generated_at="2026-07-18T12:00:00Z"))

    reports = store.list_reports()

    assert [r.id for r in reports] == ["rep-new", "rep-old"]


def test_list_reports_filters_by_status(store: ReportsStore):
    store.insert(_record(id="rep-pending"))
    store.insert(_record(id="rep-resolved", status="resolved"))

    pending = store.list_reports(status="pending")
    resolved = store.list_reports(status="resolved")

    assert [r.id for r in pending] == ["rep-pending"]
    assert [r.id for r in resolved] == ["rep-resolved"]


def test_list_reports_rejects_invalid_status_filter(store: ReportsStore):
    with pytest.raises(ValueError):
        store.list_reports(status="archived")


def test_update_status_changes_and_returns_record(store: ReportsStore):
    store.insert(_record())

    updated = store.update_status("rep-1", "resolved")

    assert updated is not None
    assert updated.status == "resolved"
    assert store.get("rep-1").status == "resolved"


def test_update_status_returns_none_for_unknown_id(store: ReportsStore):
    assert store.update_status("does-not-exist", "resolved") is None


def test_update_status_rejects_invalid_status(store: ReportsStore):
    store.insert(_record())
    with pytest.raises(ValueError):
        store.update_status("rep-1", "archived")
