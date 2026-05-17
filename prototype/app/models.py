from __future__ import annotations

from pydantic import BaseModel
from typing import Literal


class AlertRequest(BaseModel):
    scenario_id: str


class DiagnosisStep(BaseModel):
    step: Literal[
        "ALERT_RECEIVED",
        "ANALYZING_METRICS",
        "QUERYING_LOGS",
        "RAG_SEARCH",
        "GENERATING_REPORT",
        "REPORT_COMPLETE",
        "ERROR",
    ]
    message: str
    data: dict | None = None


class CustomAlertRequest(BaseModel):
    name: str = "Custom Alert"
    alert_type: str = "Custom"
    severity: str = "warning"
    service: str = "unknown-service"
    namespace: str = "default"
    description: str
    metrics: dict = {}
    logs: list[str] = []
