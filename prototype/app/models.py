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
