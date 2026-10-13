from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import pytest

from agent_core.citations import (
    SourceLedger,
    citation_scope,
    current_ledger,
    resolve_report_citations,
)
from agent_core.report import IncidentReport


@dataclass
class Hit:
    doc_id: str = "doc-1"
    chunk_index: int = 0
    file_name: str | None = "pod-restarts.md"
    title: str = "Pod restart runbook"
    section_path: list[str] = field(default_factory=lambda: ["Pods", "Diagnosis"])
    text: str = "Pods > Diagnosis\n\nCheck the previous container logs."


def _ledger(*hits: Hit) -> SourceLedger:
    ledger = SourceLedger()
    for hit in hits:
        ledger.register(hit)
    return ledger


# KB1 and KB2 are passages of doc-1, KB3 is the only passage of doc-2.
LEDGER_HITS = (
    Hit(),
    Hit(chunk_index=4, section_path=["Pods", "Fix"], text="Pods > Fix\n\nRoll back."),
    Hit(
        doc_id="doc-2",
        file_name="dns.md",
        title="DNS troubleshooting",
        section_path=[],
        text="Flush caches.",
    ),
)


def _report(**overrides) -> IncidentReport:
    base = dict(
        title="Checkout pods restarting",
        summary="Checkout pods are crash-looping.",
        error_sources=["checkout pod logs"],
        problem="The checkout pods are crash-looping.",
        remediations=["Roll back the deployment."],
        raw_diagnosis="Free-text diagnosis.",
    )
    base.update(overrides)
    return IncidentReport(**base)


def _resolve(**overrides) -> IncidentReport:
    return resolve_report_citations(_report(**overrides), _ledger(*LEDGER_HITS))


# --- SourceLedger ------------------------------------------------------


def test_ledger_hands_out_sequential_keys_and_dedups_passages():
    ledger = SourceLedger()

    assert ledger.register(Hit()) == "KB1"
    assert ledger.register(Hit(chunk_index=1)) == "KB2"
    assert ledger.register(Hit(doc_id="doc-2")) == "KB3"
    assert ledger.register(Hit()) == "KB1"
    assert len(ledger) == 3
    assert [ref.key for ref in ledger.refs()] == ["KB1", "KB2", "KB3"]
    assert ledger.get("KB4") is None


def test_ledger_ref_keeps_source_data_without_the_breadcrumb():
    ref = _ledger(Hit()).get("KB1")

    assert ref.doc_id == "doc-1"
    assert ref.chunk_index == 0
    assert ref.file_name == "pod-restarts.md"
    assert ref.section_path == ("Pods", "Diagnosis")
    assert ref.text == "Check the previous container logs."


@pytest.mark.parametrize(
    ("section_path", "text", "expected"),
    [
        ([], "Body.", "Body."),
        (["Pods"], "Other > Path\n\nBody.", "Other > Path\n\nBody."),  # not this chunk's breadcrumb
        (["Pods"], "Body only.", "Body only."),  # breadcrumbs were off on the server
    ],
)
def test_ledger_only_strips_the_chunks_own_breadcrumb(section_path, text, expected):
    assert _ledger(Hit(section_path=section_path, text=text)).get("KB1").text == expected


def test_ledger_caps_the_quote():
    ref = _ledger(Hit(section_path=[], text="x" * 5000)).get("KB1")
    assert len(ref.text) == 4000


# --- citation_scope / current_ledger ---------------------------------


def test_scope_sets_and_resets_the_current_ledger():
    assert current_ledger() is None
    with citation_scope() as outer:
        assert current_ledger() is outer
        with citation_scope() as inner:
            assert current_ledger() is inner
            assert inner is not outer
        assert current_ledger() is outer
    assert current_ledger() is None


async def test_concurrent_scopes_do_not_share_a_ledger():
    async def investigation(doc_id: str) -> SourceLedger:
        with citation_scope() as ledger:
            await asyncio.sleep(0)  # let the other task run inside its own scope
            current_ledger().register(Hit(doc_id=doc_id))
            await asyncio.sleep(0)
            return ledger

    first, second = await asyncio.gather(investigation("doc-a"), investigation("doc-b"))

    assert [ref.doc_id for ref in first.refs()] == ["doc-a"]
    assert [ref.doc_id for ref in second.refs()] == ["doc-b"]


# --- resolve_report_citations: markers -------------------------------


@pytest.mark.parametrize(
    ("problem", "expected"),
    [
        ("Logs show OOM [KB1].", "Logs show OOM [KB1]."),
        ("Logs show OOM [kb1].", "Logs show OOM [KB1]."),
        ("Logs show OOM [ KB 1 ].", "Logs show OOM [KB1]."),
        ("Logs show OOM (KB1).", "Logs show OOM [KB1]."),
        ("Logs show OOM [KB01].", "Logs show OOM [KB1]."),
        ("Logs show OOM [KB1, KB3].", "Logs show OOM [KB1][KB3]."),
        ("Logs show OOM [KB1; kb3].", "Logs show OOM [KB1][KB3]."),
        ("Logs show OOM [KB1][KB3].", "Logs show OOM [KB1][KB3]."),
        ("Logs show OOM [KB1, KB1].", "Logs show OOM [KB1]."),
        # Bare keys are not markers, and other brackets are left alone.
        ("Logs show OOM, see KB1.", "Logs show OOM, see KB1."),
        ("Set limits [memory] (512 MiB).", "Set limits [memory] (512 MiB)."),
        # Keys that were never handed out are dropped with their space.
        ("Logs show OOM [KB9].", "Logs show OOM."),
        ("Logs show OOM [KB1, KB9] here.", "Logs show OOM [KB1] here."),
        ("Logs show OOM (KB7) and [KB3].", "Logs show OOM and [KB3]."),
    ],
)
def test_markers_are_canonicalised_and_unknown_keys_dropped(problem, expected):
    assert _resolve(problem=problem).problem == expected


def test_markers_in_list_fields_are_canonicalised_and_emptied_items_dropped():
    report = _resolve(
        error_sources=["checkout pod logs (kb2)", "[KB9]"],
        remediations=["Roll back [KB2, KB8].", "Raise the memory limit."],
    )

    assert report.error_sources == ["checkout pod logs [KB2]"]
    assert report.remediations == ["Roll back [KB2].", "Raise the memory limit."]


def test_markers_are_removed_from_title_and_summary():
    report = _resolve(
        title="[KB1] Checkout pods restarting [KB9]",
        summary="Checkout pods are crash-looping [KB1, KB3].",
    )

    assert report.title == "Checkout pods restarting"
    assert report.summary == "Checkout pods are crash-looping."
    assert report.citations == []


def test_structuring_fallback_keeps_problem_equal_to_raw_diagnosis():
    raw = "Root cause: OOM [kb1]. Unknown [KB9]."
    report = _resolve(problem=raw, raw_diagnosis=raw)

    assert report.problem == report.raw_diagnosis == raw
    assert [c["key"] for c in report.citations] == ["KB1"]


def test_raw_diagnosis_is_never_rewritten_but_is_scanned():
    report = _resolve(raw_diagnosis="Per the runbook (KB3), flush caches.")

    assert report.raw_diagnosis == "Per the runbook (KB3), flush caches."
    assert [c["key"] for c in report.citations] == ["KB3"]


# --- resolve_report_citations: citations ------------------------------


def test_citations_are_ordered_by_first_mention_across_fields():
    report = _resolve(
        problem="OOM kills [KB2].",
        error_sources=["pod logs [KB3]", "events [KB2]"],
        remediations=["Roll back [KB1]."],
        raw_diagnosis="OOM kills [KB2] [KB1].",
    )

    assert [c["key"] for c in report.citations] == ["KB2", "KB3", "KB1"]


def test_citation_entry_shape():
    report = _resolve(problem="OOM kills [KB1].")

    assert report.citations == [
        {
            "key": "KB1",
            "doc_id": "doc-1",
            "file_name": "pod-restarts.md",
            "title": "Pod restart runbook",
            "section_path": ["Pods", "Diagnosis"],
            "chunk_index": 0,
            "quote": "Check the previous container logs.",
        }
    ]


def test_citation_file_name_falls_back_to_title():
    ledger = _ledger(Hit(file_name=None))

    report = resolve_report_citations(_report(problem="OOM [KB1]."), ledger)

    assert report.citations[0]["file_name"] == "Pod restart runbook"


def test_retrieved_but_uncited_documents_are_not_listed():
    assert _resolve().citations == []


def test_invented_keys_with_an_empty_ledger_are_all_dropped():
    report = resolve_report_citations(_report(problem="OOM [KB1]."), SourceLedger())

    assert report.problem == "OOM."
    assert report.citations == []


def test_returns_a_new_report():
    original = _report(problem="OOM [kb1].")

    resolved = resolve_report_citations(original, _ledger(*LEDGER_HITS))

    assert original.problem == "OOM [kb1]."
    assert original.citations == []
    assert resolved is not original


# --- resolve_report_citations: whole-document mentions -----------------


@pytest.mark.parametrize(
    ("hit", "mention"),
    [
        # The stem "db" is too short to count; "db.md" itself is not mentioned.
        (Hit(file_name="db.md", title="Database operations"), "The db pod restarted."),
        # Titles must match exactly (case included) ...
        (Hit(file_name=None, title="Pod restart runbook"), "Follow the pod restart runbook."),
        # ... and be long enough not to be a generic word.
        (Hit(file_name=None, title="Restart"), "Restart the pods."),
        # File names must stand as a whole word.
        (Hit(file_name="runbook.md", title="Generic notes"), "Several runbooks apply."),
        # A plain-word stem is the technology, not the document ...
        (
            Hit(file_name="kubernetes.md", title="Kubernetes basics guide"),
            "The Kubernetes scheduler evicted pods.",
        ),
        (Hit(file_name="README", title="Project notes"), "The README says nothing."),
        # ... and a one-word title is a word, even at the start of a sentence.
        (Hit(file_name=None, title="Troubleshooting"), "Troubleshooting showed OOM."),
    ],
)
def test_whole_document_mention_negatives(hit, mention):
    report = resolve_report_citations(_report(remediations=[mention]), _ledger(hit))

    assert report.citations == []


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("problem", "As pod-restarts.md describes, the pods are OOM-killed."),
        ("error_sources", ["POD-RESTARTS runbook"]),
        ("remediations", ["Follow the Pod restart runbook."]),
        ("raw_diagnosis", "Checked pod-restarts.md."),
    ],
)
def test_whole_document_citation_when_named_without_a_key(field_name, value):
    ledger = _ledger(Hit())

    report = resolve_report_citations(_report(**{field_name: value}), ledger)

    assert report.citations == [
        {
            "key": None,
            "doc_id": "doc-1",
            "file_name": "pod-restarts.md",
            "title": "Pod restart runbook",
            "section_path": [],
            "chunk_index": None,
            "quote": None,
        }
    ]


def test_plain_word_file_name_counts_when_written_in_full():
    ledger = _ledger(Hit(file_name="kubernetes.md", title="Kubernetes basics guide"))

    report = resolve_report_citations(_report(problem="Per Kubernetes.md, drain the node."), ledger)

    assert [(c["key"], c["file_name"]) for c in report.citations] == [(None, "kubernetes.md")]


def test_no_whole_document_entry_for_a_document_with_a_keyed_citation():
    report = _resolve(problem="OOM kills [KB2], as pod-restarts.md explains.")

    assert [(c["key"], c["doc_id"]) for c in report.citations] == [("KB2", "doc-1")]


def test_whole_document_entries_follow_keyed_ones_once_per_document():
    report = _resolve(
        problem="Flush caches [KB3].",
        remediations=["See pod-restarts.md and pod-restarts.md again."],
    )

    assert [(c["key"], c["doc_id"]) for c in report.citations] == [
        ("KB3", "doc-2"),
        (None, "doc-1"),
    ]
