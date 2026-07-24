from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from agent_core.llm.base import LLMProvider, LLMResponse
from agent_core.report import (
    IncidentReport,
    generate_report,
    parse_report_json,
    save_report,
)


class FakeProvider(LLMProvider):
    """Returns one pre-scripted response, regardless of input — enough for
    testing generate_report(), which makes exactly one call.
    """

    def __init__(self, response: LLMResponse | None = None, exc: Exception | None = None) -> None:
        self._response = response
        self._exc = exc
        self.calls: list[list] = []

    async def complete(self, messages, tools=None, **kwargs):
        self.calls.append(list(messages))
        if self._exc is not None:
            raise self._exc
        assert self._response is not None
        return self._response


# --- parse_report_json ------------------------------------------------


def test_parse_report_json_extracts_all_fields():
    raw = json.dumps(
        {
            "title": "Checkout failing due to payment timeout",
            "error_sources": ["payment pod logs", "checkout error rate metric"],
            "problem": "The payment service is timing out under load.",
            "remediations": ["Scale the payment deployment", "Increase the timeout"],
        }
    )

    report = parse_report_json(raw, fallback_diagnosis="fallback text")

    assert report.title == "Checkout failing due to payment timeout"
    assert report.error_sources == ["payment pod logs", "checkout error rate metric"]
    assert report.problem == "The payment service is timing out under load."
    assert report.remediations == ["Scale the payment deployment", "Increase the timeout"]
    assert report.raw_diagnosis == "fallback text"


def test_parse_report_json_strips_markdown_code_fence():
    raw = '```json\n{"title": "X", "problem": "Y"}\n```'

    report = parse_report_json(raw, fallback_diagnosis="fallback")

    assert report.title == "X"
    assert report.problem == "Y"


def test_parse_report_json_falls_back_gracefully_on_invalid_json():
    report = parse_report_json("this is not json at all", fallback_diagnosis="original diagnosis text")

    assert report.title == "Untitled incident report"
    assert report.problem == "original diagnosis text"
    assert report.error_sources == []
    assert report.remediations == []


def test_parse_report_json_handles_none_input():
    report = parse_report_json(None, fallback_diagnosis="original diagnosis text")

    assert report.problem == "original diagnosis text"


def test_parse_report_json_wraps_single_string_field_into_a_list():
    raw = json.dumps({"title": "X", "error_sources": "just one source", "problem": "Y"})

    report = parse_report_json(raw, fallback_diagnosis="fallback")

    assert report.error_sources == ["just one source"]


def test_parse_report_json_ignores_unrelated_extra_keys():
    raw = json.dumps({"title": "X", "problem": "Y", "confidence": 0.9, "unused": True})

    report = parse_report_json(raw, fallback_diagnosis="fallback")

    assert report.title == "X"
    assert report.problem == "Y"


# --- save_report --------------------------------------------------------


def test_save_report_writes_expected_json_structure(tmp_path):
    report = IncidentReport(
        title="Checkout errors",
        error_sources=["checkout pod logs"],
        problem="Payment timeouts.",
        remediations=["Scale payment service."],
        raw_diagnosis="full free-text diagnosis",
    )
    fixed_time = datetime(2026, 7, 18, 14, 30, 0, tzinfo=timezone.utc)

    path = save_report(report, tmp_path, now=fixed_time)

    assert path.exists()
    assert path.name == "20260718T143000Z-report.json"
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["title"] == "Checkout errors"
    assert saved["error_sources"] == ["checkout pod logs"]
    assert saved["problem"] == "Payment timeouts."
    assert saved["remediations"] == ["Scale payment service."]
    assert saved["raw_diagnosis"] == "full free-text diagnosis"
    assert saved["generated_at"] == "2026-07-18T14:30:00Z"


def test_save_report_creates_missing_directories(tmp_path):
    nested_dir = tmp_path / "a" / "b" / "c"
    report = IncidentReport(
        title="X", error_sources=[], problem="Y", remediations=[], raw_diagnosis="Y"
    )

    path = save_report(report, nested_dir)

    assert path.exists()
    assert path.parent == nested_dir


# --- generate_report (async, needs a provider) --------------------------


@pytest.mark.asyncio
async def test_generate_report_uses_provider_response():
    raw = json.dumps({"title": "X", "problem": "Y", "error_sources": [], "remediations": []})
    provider = FakeProvider(response=LLMResponse(content=raw, tool_calls=[]))

    report = await generate_report(provider, "some free-text diagnosis")

    assert report.title == "X"
    assert report.problem == "Y"
    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_generate_report_falls_back_when_provider_call_fails():
    provider = FakeProvider(exc=RuntimeError("rate limited"))

    report = await generate_report(provider, "original diagnosis text")

    assert report.problem == "original diagnosis text"
    assert report.title == "Untitled incident report"
