"""Turns the agent's free-text diagnosis into a structured report (title,
error sources, problem description, remediations) and saves it as a JSON
file on disk.

Split into three layers, in increasing order of "impurity":
  - `parse_report_json` — pure, no I/O, easy to unit test with hand-written
    JSON strings.
  - `save_report` — does I/O (writes a file), but takes the data to write
    as a plain argument, so it's still easy to test against a tmp_path.
  - `generate_report` — the only piece that needs a live LLMProvider; it
    asks the model to restructure its own free-text diagnosis into JSON.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agent_core.llm.base import LLMProvider, Message, Role

logger = logging.getLogger(__name__)

REPORT_SYSTEM_PROMPT = (
    "You will be given a diagnostic report written in free text. Convert it "
    "into a JSON object with EXACTLY these keys, and nothing else:\n"
    '- "title": a short, one-line summary of the incident (max ~10 words).\n'
    '- "error_sources": a list of strings identifying where the evidence '
    "for the problem was found (e.g. specific pods, log queries, metrics, "
    "dashboards).\n"
    '- "problem": a concise paragraph describing what is actually wrong.\n'
    '- "remediations": a list of strings, each one concrete suggested next '
    "step.\n"
    "Respond with ONLY the JSON object — no markdown code fences, no "
    "commentary before or after it. If the original report says the cause "
    "is uncertain, reflect that honestly in \"problem\" rather than "
    "inventing a confident answer."
)


@dataclass
class IncidentReport:
    title: str
    error_sources: list[str]
    problem: str
    remediations: list[str]
    raw_diagnosis: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "error_sources": self.error_sources,
            "problem": self.problem,
            "remediations": self.remediations,
            "raw_diagnosis": self.raw_diagnosis,
        }


def _as_string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def parse_report_json(raw_text: str | None, fallback_diagnosis: str) -> IncidentReport:
    """Parses the model's structuring response into an `IncidentReport`.

    Tolerant by design: models occasionally wrap JSON in a markdown code
    fence despite being told not to, use a single string instead of a list
    for a field, or omit a key entirely. None of that should lose the
    underlying diagnosis — if parsing fails completely, `problem` falls
    back to the original free-text diagnosis so nothing is silently
    dropped, it just isn't structured.
    """
    text = (raw_text or "").strip()

    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    data: Any = {}
    if text:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            logger.warning("Report structuring response was not valid JSON; using raw text.")
            data = {}
    if not isinstance(data, dict):
        data = {}

    title = data.get("title")
    title = str(title).strip() if isinstance(title, str) and title.strip() else "Untitled incident report"

    problem = data.get("problem")
    problem = str(problem).strip() if isinstance(problem, str) and problem.strip() else fallback_diagnosis

    return IncidentReport(
        title=title,
        error_sources=_as_string_list(data.get("error_sources")),
        problem=problem,
        remediations=_as_string_list(data.get("remediations")),
        raw_diagnosis=fallback_diagnosis,
    )


def save_report(
    report: IncidentReport,
    output_dir: str | Path,
    *,
    now: datetime | None = None,
) -> Path:
    """Writes the report as a JSON file under `output_dir` and returns its path.

    Filename is timestamp-based (e.g. 20260718T143000Z-report.json) so
    repeated investigations don't overwrite each other. `now` is injectable
    for deterministic tests.
    """
    now = now or datetime.now(timezone.utc)
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)

    filename = f"{now.strftime('%Y%m%dT%H%M%SZ')}-report.json"
    path = directory / filename

    payload = {"generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), **report.to_dict()}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


async def generate_report(provider: LLMProvider, diagnosis_text: str) -> IncidentReport:
    """Asks the LLM to restructure its own free-text diagnosis into the
    fixed {title, error_sources, problem, remediations} shape.

    A dedicated call (no tools offered) rather than trying to make the
    agent's main system prompt produce valid JSON directly — this keeps
    the ReAct loop's system prompt focused on the investigation itself,
    and isolates "did the structuring step work" from "did the
    investigation work", which matters for debugging when only one of the
    two goes wrong.
    """
    messages = [
        Message(role=Role.SYSTEM, content=REPORT_SYSTEM_PROMPT),
        Message(role=Role.USER, content=diagnosis_text),
    ]
    try:
        response = await provider.complete(messages, tools=None)
        raw_text = response.content
    except Exception as exc:
        logger.error("Report structuring call failed, falling back to raw text: %s", exc)
        raw_text = None

    return parse_report_json(raw_text, fallback_diagnosis=diagnosis_text)
