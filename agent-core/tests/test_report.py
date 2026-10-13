from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from agent_core.citations import SourceLedger
from agent_core.llm.base import LLMProvider, LLMResponse, Message, Role
from agent_core.prompting import load
from agent_core.report import (
    REPORT_SYSTEM_PROMPT,
    IncidentReport,
    generate_report,
    parse_report_json,
    render_report_markdown,
    save_report,
)


KEYED_CITATION = {
    "key": "KB1",
    "doc_id": "doc-1",
    "file_name": "pod-restarts.md",
    "title": "Pod restart runbook",
    "section_path": ["Pods", "Diagnosis"],
    "chunk_index": 0,
    "quote": "Check the previous container logs.",
}
WHOLE_DOCUMENT_CITATION = {
    "key": None,
    "doc_id": "doc-2",
    "file_name": "dns.md",
    "title": "DNS troubleshooting",
    "section_path": [],
    "chunk_index": None,
    "quote": None,
}


def _ledger() -> SourceLedger:
    ledger = SourceLedger()
    ledger.register(SimpleNamespace(
        doc_id="doc-1", chunk_index=0, file_name="pod-restarts.md", title="Pod restart runbook",
        section_path=["Pods", "Diagnosis"], text="Pods > Diagnosis\n\nCheck logs.",
    ))
    ledger.register(SimpleNamespace(
        doc_id="doc-2", chunk_index=0, file_name=None, title="DNS troubleshooting",
        section_path=[], text="Flush caches.",
    ))
    return ledger


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
            "summary": "Checkout is failing because payments are timing out.",
            "error_sources": ["payment pod logs", "checkout error rate metric"],
            "problem": "The payment service is timing out under load.",
            "remediations": ["Scale the payment deployment", "Increase the timeout"],
        }
    )

    report = parse_report_json(raw, fallback_diagnosis="fallback text")

    assert report.title == "Checkout failing due to payment timeout"
    assert report.summary == "Checkout is failing because payments are timing out."
    assert report.error_sources == ["payment pod logs", "checkout error rate metric"]
    assert report.problem == "The payment service is timing out under load."
    assert report.remediations == ["Scale the payment deployment", "Increase the timeout"]
    assert report.raw_diagnosis == "fallback text"


def test_parse_report_json_falls_back_to_truncated_problem_when_summary_missing():
    long_problem = "This is a very long problem description. " * 10
    raw = json.dumps({"title": "X", "problem": long_problem})

    report = parse_report_json(raw, fallback_diagnosis="fallback")

    assert report.summary != ""
    assert len(report.summary) <= 161  # fallback max chars + ellipsis
    assert report.summary.endswith("…")


def test_parse_report_json_keeps_short_problem_as_summary_when_missing():
    raw = json.dumps({"title": "X", "problem": "Short problem."})

    report = parse_report_json(raw, fallback_diagnosis="fallback")

    assert report.summary == "Short problem."


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
        summary="Payments are timing out under load.",
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
    assert saved["summary"] == "Payments are timing out under load."
    assert saved["error_sources"] == ["checkout pod logs"]
    assert saved["problem"] == "Payment timeouts."
    assert saved["remediations"] == ["Scale payment service."]
    assert saved["raw_diagnosis"] == "full free-text diagnosis"
    assert saved["citations"] == []
    assert saved["generated_at"] == "2026-07-18T14:30:00Z"


def test_save_report_includes_citations(tmp_path):
    report = IncidentReport(
        title="X", error_sources=[], problem="Y [KB1]", remediations=[], raw_diagnosis="Y [KB1]",
        citations=[KEYED_CITATION],
    )

    path = save_report(report, tmp_path)

    assert json.loads(path.read_text(encoding="utf-8"))["citations"] == [KEYED_CITATION]
    assert report.to_dict()["citations"] == [KEYED_CITATION]


def test_save_report_creates_missing_directories(tmp_path):
    nested_dir = tmp_path / "a" / "b" / "c"
    report = IncidentReport(
        title="X", error_sources=[], problem="Y", remediations=[], raw_diagnosis="Y"
    )

    path = save_report(report, nested_dir)

    assert path.exists()
    assert path.parent == nested_dir


# --- render_report_markdown ---------------------------------------------


def test_render_report_markdown_includes_all_sections():
    report = IncidentReport(
        title="Checkout errors",
        summary="Payments are timing out under load.",
        error_sources=["checkout pod logs", "payment error rate metric"],
        problem="The payment service is timing out under load.",
        remediations=["Scale the payment deployment", "Increase the timeout"],
        raw_diagnosis="full free-text diagnosis",
    )

    markdown = render_report_markdown(report)

    assert markdown.startswith("# Checkout errors")
    assert "Payments are timing out under load." in markdown
    assert "## Problem" in markdown
    assert "The payment service is timing out under load." in markdown
    assert "## Error sources" in markdown
    assert "- checkout pod logs" in markdown
    assert "- payment error rate metric" in markdown
    assert "## Suggested remediations" in markdown
    assert "- Scale the payment deployment" in markdown
    assert "## Raw diagnosis" in markdown
    assert "full free-text diagnosis" in markdown


def test_render_report_markdown_omits_empty_list_sections():
    report = IncidentReport(
        title="X",
        summary="Y",
        error_sources=[],
        problem="Z",
        remediations=[],
        raw_diagnosis="raw",
    )

    markdown = render_report_markdown(report)

    assert "## Error sources" not in markdown
    assert "## Suggested remediations" not in markdown
    assert "## Documentation sources" not in markdown


def test_render_report_markdown_lists_documentation_sources():
    report = IncidentReport(
        title="X",
        summary="Y",
        error_sources=[],
        problem="Z [KB1]",
        remediations=[],
        raw_diagnosis="raw",
        citations=[KEYED_CITATION, WHOLE_DOCUMENT_CITATION],
    )

    markdown = render_report_markdown(report)

    assert markdown.endswith(
        "## Documentation sources\n\n"
        "- [KB1] pod-restarts.md — Pods > Diagnosis\n"
        "- dns.md\n"
    )


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


@pytest.mark.asyncio
async def test_generate_report_lists_source_keys_and_resolves_citations():
    raw = json.dumps({"title": "X [KB1]", "problem": "Pods restart [kb1] [KB7].", "remediations": []})
    provider = FakeProvider(response=LLMResponse(content=raw, tool_calls=[]))

    report = await generate_report(provider, "Pods restart [KB1].", _ledger())

    system, keys, user = provider.calls[0]
    # Document names and headings are untrusted data: never in the system role.
    assert system == Message(role=Role.SYSTEM, content=REPORT_SYSTEM_PROMPT)
    assert keys.role == Role.USER
    assert keys.content.endswith(
        "KB1 = pod-restarts.md (Pods > Diagnosis); KB2 = DNS troubleshooting."
    )
    assert keys.content.startswith("Reference only")
    assert user == Message(role=Role.USER, content="Pods restart [KB1].")
    assert report.title == "X"
    assert report.problem == "Pods restart [KB1]."
    assert report.raw_diagnosis == "Pods restart [KB1]."
    assert [c["key"] for c in report.citations] == ["KB1"]


@pytest.mark.asyncio
@pytest.mark.parametrize("ledger", [None, SourceLedger()])
async def test_generate_report_without_sources_lists_no_keys(ledger):
    raw = json.dumps({"title": "X", "problem": "Y [KB1]."})
    provider = FakeProvider(response=LLMResponse(content=raw, tool_calls=[]))

    report = await generate_report(provider, "diagnosis", ledger)

    assert [m.content for m in provider.calls[0]] == [REPORT_SYSTEM_PROMPT, "diagnosis"]
    assert report.citations == []
    # Only a given ledger resolves (and so drops) markers.
    assert report.problem == ("Y [KB1]." if ledger is None else "Y.")


@pytest.mark.asyncio
async def test_generate_report_caps_document_labels_in_the_key_list():
    ledger = SourceLedger()
    ledger.register(SimpleNamespace(
        doc_id="doc-1", chunk_index=0, file_name="f" * 300 + ".md", title="T",
        section_path=["S" * 300], text="Check logs.",
    ))
    provider = FakeProvider(response=LLMResponse(content="{}", tool_calls=[]))

    await generate_report(provider, "diagnosis", ledger)

    keys = provider.calls[0][1].content
    assert keys.endswith(f"KB1 = {'f' * 120} ({'S' * 120}).")


def test_report_prompt_asks_for_markers_but_not_ids():
    assert "[KB1]" in REPORT_SYSTEM_PROMPT
    assert "doc_id" not in REPORT_SYSTEM_PROMPT


def test_report_prompt_is_loaded_from_its_file_and_names_every_key():
    assert REPORT_SYSTEM_PROMPT == load("report")
    for key in ('"title"', '"summary"', '"error_sources"', '"problem"', '"remediations"'):
        assert key in REPORT_SYSTEM_PROMPT
