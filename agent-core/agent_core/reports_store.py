"""Small, mutable store for incident reports, separate from the JSON files
written by `report.save_report`.

Those files are append-only artifacts (one per investigation, named by
timestamp) — good as a durable log, bad as a place to track a field the
client needs to change, like `status` (pending/resolved). This module adds
a thin SQLite-backed store on the side: one row per finished investigation,
carrying the same narrative fields as `IncidentReport` plus the bits the
client's web panel actually needs to render a list/detail view (`id`,
`service`, `severity`, `status`, `content_md`) that the LLM's structuring
step either doesn't produce (`id`) or shouldn't be trusted to invent
(`service`/`severity` — those come from the alert's own labels, see
`incident.extract_incident_meta_from_webhook`).

SQLite (stdlib, no new dependency) is deliberately overkill-free for this
project's scale: a handful of investigations per day, a single process.
Kept as a small class around one connection rather than a query-per-call
module so tests can point it at ":memory:" and get a fresh, isolated store
per test with no file cleanup.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

VALID_STATUSES = ("pending", "resolved")


@dataclass
class ReportRecord:
    id: str
    generated_at: str
    title: str
    service: str
    severity: str
    summary: str
    problem: str
    error_sources: list[str]
    remediations: list[str]
    raw_diagnosis: str
    content_md: str
    status: str = "pending"

    def __post_init__(self) -> None:
        if self.status not in VALID_STATUSES:
            raise ValueError(f"Invalid status '{self.status}', expected one of {VALID_STATUSES}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "generated_at": self.generated_at,
            "title": self.title,
            "service": self.service,
            "severity": self.severity,
            "status": self.status,
            "summary": self.summary,
            "problem": self.problem,
            "error_sources": list(self.error_sources),
            "remediations": list(self.remediations),
            "raw_diagnosis": self.raw_diagnosis,
            "content_md": self.content_md,
        }


_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL,
    title TEXT NOT NULL,
    service TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    problem TEXT NOT NULL,
    error_sources TEXT NOT NULL,
    remediations TEXT NOT NULL,
    raw_diagnosis TEXT NOT NULL,
    content_md TEXT NOT NULL
)
"""


class ReportsStore:
    """Thin wrapper around a single SQLite connection.

    Not thread-safe under genuine concurrent access — this project runs a
    single asyncio event loop in one process, so calls are cooperative and
    never truly concurrent. `check_same_thread=False` is needed anyway:
    ASGI test tooling (e.g. FastAPI's TestClient) runs the app on a worker
    thread distinct from the one that constructed this store, even though
    only one thread ever touches it at a time. If a future entry point
    moves store access to genuinely concurrent threads or processes, this
    class is the place to add locking or switch to a connection-per-call
    pattern — callers should not need to change.
    """

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = str(db_path)
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.execute(_CREATE_TABLE_SQL)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def insert(self, record: ReportRecord) -> None:
        self._conn.execute(
            """
            INSERT INTO reports (
                id, generated_at, title, service, severity, status,
                summary, problem, error_sources, remediations,
                raw_diagnosis, content_md
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.generated_at,
                record.title,
                record.service,
                record.severity,
                record.status,
                record.summary,
                record.problem,
                json.dumps(record.error_sources),
                json.dumps(record.remediations),
                record.raw_diagnosis,
                record.content_md,
            ),
        )
        self._conn.commit()

    def list_reports(self, status: str | None = None) -> list[ReportRecord]:
        """Returns reports newest-first, optionally filtered by status."""
        if status is not None and status not in VALID_STATUSES:
            raise ValueError(f"Invalid status '{status}', expected one of {VALID_STATUSES}")

        if status is None:
            rows = self._conn.execute(
                "SELECT * FROM reports ORDER BY generated_at DESC"
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM reports WHERE status = ? ORDER BY generated_at DESC",
                (status,),
            ).fetchall()
        return [self._row_to_record(row) for row in rows]

    def get(self, report_id: str) -> ReportRecord | None:
        row = self._conn.execute(
            "SELECT * FROM reports WHERE id = ?", (report_id,)
        ).fetchone()
        return self._row_to_record(row) if row else None

    def update_status(self, report_id: str, status: str) -> ReportRecord | None:
        """Updates `status` in place. Returns the updated record, or None
        if no report with this id exists. Raises ValueError for anything
        other than a recognized status, so a typo from a future API layer
        fails loudly instead of silently writing garbage.
        """
        if status not in VALID_STATUSES:
            raise ValueError(f"Invalid status '{status}', expected one of {VALID_STATUSES}")

        cursor = self._conn.execute(
            "UPDATE reports SET status = ? WHERE id = ?", (status, report_id)
        )
        self._conn.commit()
        if cursor.rowcount == 0:
            return None
        return self.get(report_id)

    def _row_to_record(self, row: sqlite3.Row | tuple) -> ReportRecord:
        (
            id_,
            generated_at,
            title,
            service,
            severity,
            status,
            summary,
            problem,
            error_sources,
            remediations,
            raw_diagnosis,
            content_md,
        ) = row
        return ReportRecord(
            id=id_,
            generated_at=generated_at,
            title=title,
            service=service,
            severity=severity,
            status=status,
            summary=summary,
            problem=problem,
            error_sources=json.loads(error_sources),
            remediations=json.loads(remediations),
            raw_diagnosis=raw_diagnosis,
            content_md=content_md,
        )
