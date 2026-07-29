from __future__ import annotations

import pytest
from pydantic import ValidationError

from agent_core.reports_api import ReportDetail, ReportSummary, StatusUpdate
from agent_core.reports_store import ReportRecord


def _record() -> ReportRecord:
    return ReportRecord(
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


def test_report_summary_excludes_detail_only_fields():
    summary = ReportSummary.model_validate(_record().to_dict())

    dumped = summary.model_dump()
    assert dumped["id"] == "rep-1"
    assert dumped["title"] == "Checkout errors"
    assert "content_md" not in dumped
    assert "raw_diagnosis" not in dumped
    assert "problem" not in dumped


def test_report_detail_includes_all_fields():
    detail = ReportDetail.model_validate(_record().to_dict())

    dumped = detail.model_dump()
    assert dumped["content_md"] == "# Checkout errors\n\nfull content"
    assert dumped["problem"] == "The payment service is timing out under load."
    assert dumped["error_sources"] == ["checkout pod logs"]
    assert dumped["remediations"] == ["Scale the payment deployment"]


def test_status_update_accepts_valid_statuses():
    assert StatusUpdate(status="pending").status == "pending"
    assert StatusUpdate(status="resolved").status == "resolved"


def test_status_update_rejects_invalid_status():
    with pytest.raises(ValidationError):
        StatusUpdate(status="archived")
