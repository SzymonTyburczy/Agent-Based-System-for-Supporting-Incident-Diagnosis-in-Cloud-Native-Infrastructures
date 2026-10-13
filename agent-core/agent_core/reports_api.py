"""Pydantic schemas for the client-facing /reports* API.

Kept separate from webhook_server.py so the shape of what the web panel
receives (summary vs. detail — deliberately not the same fields) is
something a test can pin down without spinning up a live FastAPI app.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ReportSummary(BaseModel):
    """List-view shape — deliberately excludes the heavier narrative
    fields (problem, error_sources, remediations, raw_diagnosis,
    content_md, citations), which only the detail view needs.
    """

    id: str
    generated_at: str
    title: str
    service: str
    severity: str
    status: str
    summary: str


class Citation(BaseModel):
    """One documentation source the report relies on (see
    citations.resolve_report_citations). `key` is the [KBn] marker used in
    the report's text; it, `chunk_index` and `quote` are null for a
    document the report names as a whole rather than citing a passage of.
    """

    key: str | None
    doc_id: str
    file_name: str
    title: str
    section_path: list[str]
    chunk_index: int | None
    quote: str | None


class ReportDetail(ReportSummary):
    """Full record, for the issue detail page."""

    problem: str
    error_sources: list[str]
    remediations: list[str]
    raw_diagnosis: str
    content_md: str
    citations: list[Citation] = []


class StatusUpdate(BaseModel):
    """PATCH /reports/{id} body. Restricted to the store's own valid
    statuses so an invalid value is rejected by FastAPI's request
    validation (422) before it ever reaches the store.
    """

    status: Literal["pending", "resolved"]
