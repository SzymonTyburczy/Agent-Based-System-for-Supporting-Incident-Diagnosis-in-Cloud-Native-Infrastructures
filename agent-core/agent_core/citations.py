"""Documentation citations: short run-scoped source keys instead of document ids.

The LLM never copies a knowledge-base document id. Every search hit is shown
to it under a key such as [KB1], and the `SourceLedger` remembers which RAG
passage each key stands for. After the run, `resolve_report_citations` maps
the keys the report actually uses back to that data. A key the model invents
resolves to nothing and is dropped, so the client can never link a statement
to the wrong document.

Pure: no I/O, so every rule here is unit-testable with hand-written reports.
"""

from __future__ import annotations

import dataclasses
import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Iterator, Protocol, Sequence

if TYPE_CHECKING:
    from agent_core.report import IncidentReport

# Same cap as the search tool's excerpts, so the quote never holds more than
# the model was shown.
_QUOTE_MAX_CHARS = 4000

# Below these lengths a file name or title is too generic ("db.md",
# "Overview") to count as a mention of one specific document.
_MIN_FILE_NAME_CHARS = 4
_MIN_TITLE_CHARS = 8
# A file name, or its stem, names one document only when it reads as a file
# reference: an extension, or an identifier such as crashloop-runbook or
# pg_restore_v2. The bare stem of kubernetes.md or redis.md is a word most
# reports use without relying on that document.
_FILE_LIKE_RE = re.compile(r"[-_.\d]")

_KEY_ATOM = r"KB\s*\d+"
# The separator is written as "\s*(?:[,;]\s*)?" rather than "\s*[,;]?\s*" so
# a long run of whitespace has only one way to match (no quadratic
# backtracking on model output).
_KEY_LIST = rf"\s*{_KEY_ATOM}(?:\s*(?:[,;]\s*)?{_KEY_ATOM})*\s*"
# One marker group: [KB1], [ kb 1 ], (KB1), [KB1, KB3]. The optional leading
# space is captured so a dropped marker takes it along instead of leaving a
# gap before the punctuation that followed it. A bare KB1 is not a marker.
_MARKER_RE = re.compile(rf"(?P<space> ?)(?:\[{_KEY_LIST}\]|\({_KEY_LIST}\))", re.IGNORECASE)
_KEY_DIGITS_RE = re.compile(r"KB\s*(\d+)", re.IGNORECASE)


class SearchHit(Protocol):
    """The fields of a knowledge-base search result the ledger keeps."""

    doc_id: str
    chunk_index: int
    file_name: str | None
    title: str
    section_path: Sequence[str]
    text: str


@dataclass(frozen=True)
class SourceRef:
    key: str
    doc_id: str
    chunk_index: int
    file_name: str | None
    title: str
    section_path: tuple[str, ...]
    text: str


def _strip_breadcrumb(text: str, section_path: Sequence[str]) -> str:
    # The RAG server prepends "A > B\n\n" to chunks when breadcrumbs are on;
    # the quote must be the document's own text so the client can find it.
    prefix = " > ".join(section_path) + "\n\n"
    if section_path and text.startswith(prefix):
        return text[len(prefix) :]
    return text


class SourceLedger:
    """Hands out [KBn] keys for search hits within one investigation."""

    def __init__(self) -> None:
        self._refs: dict[str, SourceRef] = {}
        self._keys: dict[tuple[str, int], str] = {}

    def register(self, hit: SearchHit) -> str:
        # Keyed on the passage, not the search: a chunk found again by a
        # later query keeps the key the model may already have used.
        identity = (hit.doc_id, hit.chunk_index)
        existing = self._keys.get(identity)
        if existing is not None:
            return existing
        key = f"KB{len(self._refs) + 1}"
        self._keys[identity] = key
        self._refs[key] = SourceRef(
            key=key,
            doc_id=hit.doc_id,
            chunk_index=hit.chunk_index,
            file_name=hit.file_name,
            title=hit.title,
            section_path=tuple(hit.section_path),
            text=_strip_breadcrumb(hit.text, hit.section_path)[:_QUOTE_MAX_CHARS],
        )
        return key

    def get(self, key: str) -> SourceRef | None:
        return self._refs.get(key)

    def refs(self) -> list[SourceRef]:
        return list(self._refs.values())

    def __len__(self) -> int:
        return len(self._refs)


# Lets the search tool find the current investigation's ledger without
# threading it through ToolRegistry and AgentLoop. Safe because
# ToolRegistry.call awaits tool.execute in the caller's task and AgentLoop
# runs tool calls one after another, so every search of a run sees the
# scope its entry point opened.
_current_ledger: ContextVar[SourceLedger | None] = ContextVar("citation_ledger", default=None)


@contextmanager
def citation_scope() -> Iterator[SourceLedger]:
    ledger = SourceLedger()
    token = _current_ledger.set(ledger)
    try:
        yield ledger
    finally:
        _current_ledger.reset(token)


def current_ledger() -> SourceLedger | None:
    return _current_ledger.get()


def _keys_in(marker: str) -> list[str]:
    # dict.fromkeys de-duplicates "[KB1, KB1]" while keeping the order.
    return list(dict.fromkeys(f"KB{int(digits)}" for digits in _KEY_DIGITS_RE.findall(marker)))


def _canonicalise(text: str, ledger: SourceLedger) -> str:
    """Rewrites every marker group as [KB1][KB3] and drops unknown keys."""

    def replace(match: re.Match[str]) -> str:
        known = [key for key in _keys_in(match.group(0)) if ledger.get(key) is not None]
        if not known:
            return ""
        return match.group("space") + "".join(f"[{key}]" for key in known)

    return _MARKER_RE.sub(replace, text)


def _strip_markers(text: str) -> str:
    return _MARKER_RE.sub("", text).strip()


def _known_keys(text: str, ledger: SourceLedger) -> list[str]:
    return [
        key
        for match in _MARKER_RE.finditer(text)
        for key in _keys_in(match.group(0))
        if ledger.get(key) is not None
    ]


def _mentions(text: str, needle: str, *, ignore_case: bool) -> bool:
    # Word-boundary lookarounds, so "runbook" is not found inside "runbooks".
    flags = re.IGNORECASE if ignore_case else 0
    return re.search(rf"(?<!\w){re.escape(needle)}(?!\w)", text, flags) is not None


def _is_mentioned(ref: SourceRef, text: str) -> bool:
    if ref.file_name:
        stem = ref.file_name.rsplit(".", 1)[0]
        for name in dict.fromkeys((ref.file_name, stem)):
            if (
                len(name) >= _MIN_FILE_NAME_CHARS
                and _FILE_LIKE_RE.search(name)
                and _mentions(text, name, ignore_case=True)
            ):
                return True
    # A one-word title ("Troubleshooting") is a word, not a document's name.
    return (
        len(ref.title) >= _MIN_TITLE_CHARS
        and len(ref.title.split()) > 1
        and _mentions(text, ref.title, ignore_case=False)
    )


def resolve_report_citations(report: IncidentReport, ledger: SourceLedger) -> IncidentReport:
    """Returns `report` with canonical, known-only markers and its `citations`.

    `citations` holds one entry per distinct key the report uses, in order of
    first mention, then one key-less entry per retrieved document the report
    names (file name or exact title) without citing any of its passages.
    Documents that were retrieved but not relied on are not listed.
    """
    # parse_report_json falls back to problem == raw_diagnosis when
    # structuring fails, and the client detects that fallback by string
    # equality, so neither may be rewritten in that case.
    structured = report.problem != report.raw_diagnosis
    problem = _canonicalise(report.problem, ledger) if structured else report.problem
    error_sources = [
        item for item in (_canonicalise(s, ledger) for s in report.error_sources) if item.strip()
    ]
    remediations = [
        item for item in (_canonicalise(s, ledger) for s in report.remediations) if item.strip()
    ]

    scanned = [problem, *error_sources, *remediations, report.raw_diagnosis]
    citations: list[dict[str, Any]] = []
    cited_docs: set[str] = set()
    for key in dict.fromkeys(key for text in scanned for key in _known_keys(text, ledger)):
        ref = ledger.get(key)
        assert ref is not None  # _known_keys only yields ledger keys
        cited_docs.add(ref.doc_id)
        citations.append(
            {
                "key": ref.key,
                "doc_id": ref.doc_id,
                "file_name": ref.file_name or ref.title,
                "title": ref.title,
                "section_path": list(ref.section_path),
                "chunk_index": ref.chunk_index,
                "quote": ref.text,
            }
        )

    whole_text = "\n".join(scanned)
    for ref in ledger.refs():
        if ref.doc_id in cited_docs or not _is_mentioned(ref, whole_text):
            continue
        cited_docs.add(ref.doc_id)
        citations.append(
            {
                "key": None,
                "doc_id": ref.doc_id,
                "file_name": ref.file_name or ref.title,
                "title": ref.title,
                "section_path": [],
                "chunk_index": None,
                "quote": None,
            }
        )

    return dataclasses.replace(
        report,
        title=_strip_markers(report.title),
        summary=_strip_markers(report.summary),
        problem=problem,
        error_sources=error_sources,
        remediations=remediations,
        citations=citations,
    )
