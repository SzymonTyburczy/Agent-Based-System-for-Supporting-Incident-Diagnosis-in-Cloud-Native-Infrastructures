import re
from pathlib import Path

from app.rag.chunking import (
    CHARS_PER_TOKEN,
    MIN_CHUNK_TOKENS,
    build_chunks,
    extract_title,
)

FIXTURE = (Path(__file__).parent / "fixtures" / "runbook_crashloop.md").read_text(encoding="utf-8")


def fences_balanced(text: str) -> bool:
    markers = [line for line in text.splitlines() if re.match(r"^(`{3,}|~{3,})", line.strip())]
    return len(markers) % 2 == 0


def test_no_chunk_cuts_inside_code_fence():
    chunks = build_chunks(FIXTURE, max_tokens=120, overlap_tokens=0, breadcrumbs=False)

    assert chunks
    for chunk in chunks:
        assert fences_balanced(chunk.text), f"fence cut inside a chunk: {chunk.text!r}"


def test_oversized_fence_stays_whole():
    fence = (
        "```yaml\n"
        + "\n".join(f"key_{i}: value_{i}" for i in range(60))
        + "\n\n# a YAML comment, not a heading\n```"
    )
    markdown = f"# Title\n\nIntro before the block.\n\n{fence}\n\nClosing words after the block."

    chunks = build_chunks(markdown, max_tokens=60, overlap_tokens=0, breadcrumbs=False)

    fence_chunks = [c for c in chunks if "```yaml" in c.text]
    assert len(fence_chunks) == 1
    assert fences_balanced(fence_chunks[0].text)
    assert "# a YAML comment, not a heading" in fence_chunks[0].text


def test_section_paths_follow_header_tree():
    chunks = build_chunks(FIXTURE, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    paths = {c.section_path for c in chunks}
    assert ("Runbook: CrashLoopBackOff",) in paths
    assert ("Runbook: CrashLoopBackOff", "Diagnosis") in paths
    assert ("Runbook: CrashLoopBackOff", "Diagnosis", "Container logs") in paths
    assert ("Runbook: CrashLoopBackOff", "Exit codes") in paths


def test_breadcrumb_prefixes_chunk_text():
    chunks = build_chunks(FIXTURE, max_tokens=600, overlap_tokens=0, breadcrumbs=True)

    logs = [
        c
        for c in chunks
        if c.section_path == ("Runbook: CrashLoopBackOff", "Diagnosis", "Container logs")
    ]
    assert logs
    assert logs[0].text.startswith("Runbook: CrashLoopBackOff > Diagnosis > Container logs\n\n")


def test_breadcrumbs_can_be_disabled():
    chunks = build_chunks(FIXTURE, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert all(not c.text.startswith("Runbook: CrashLoopBackOff > ") for c in chunks)


def test_every_source_line_survives():
    chunks = build_chunks(FIXTURE, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    combined = "\n\n".join(c.text for c in chunks)
    for line in FIXTURE.splitlines():
        stripped = line.strip()
        if stripped:
            assert stripped in combined, f"lost line: {stripped!r}"


def test_long_section_respects_max_size():
    paragraphs = [
        f"Paragraph number {i}. " + "Diagnostics takes patience and logs. " * 4 for i in range(15)
    ]
    markdown = "# Long document\n\n## Section\n\n" + "\n\n".join(paragraphs)
    max_tokens = 120

    chunks = build_chunks(markdown, max_tokens=max_tokens, overlap_tokens=0, breadcrumbs=False)

    max_chars = int(max_tokens * CHARS_PER_TOKEN)
    tail_allowance = int(MIN_CHUNK_TOKENS * CHARS_PER_TOKEN) + 2
    assert len(chunks) > 3
    assert all(len(c.text) <= max_chars + tail_allowance for c in chunks)


def test_giant_paragraph_is_sentence_split_with_overlap():
    sentences = [
        f"Sentence number {i} describes the next step in diagnosing a cluster incident."
        for i in range(30)
    ]
    markdown = "# Document\n\n" + " ".join(sentences)

    with_overlap = build_chunks(markdown, max_tokens=120, overlap_tokens=30, breadcrumbs=False)
    without_overlap = build_chunks(markdown, max_tokens=120, overlap_tokens=0, breadcrumbs=False)

    assert len(with_overlap) > 2
    assert any(
        with_overlap[i + 1].text[:25] in with_overlap[i].text for i in range(len(with_overlap) - 1)
    )
    assert all(
        without_overlap[i + 1].text[:25] not in without_overlap[i].text
        for i in range(len(without_overlap) - 1)
    )


def test_tiny_tail_is_merged_into_previous_chunk():
    markdown = "# Document\n\n## Section\n\n" + "A" * 415 + "\n\nShort tail."

    chunks = build_chunks(markdown, max_tokens=120, overlap_tokens=0, breadcrumbs=False)

    assert len(chunks) == 1
    assert "Short tail." in chunks[0].text


def test_header_only_section_produces_no_chunk():
    markdown = "# Title\n\n## Empty\n\n### Subsection\n\nSubsection body."

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    paths = [c.section_path for c in chunks]
    assert ("Title", "Empty") not in paths
    assert ("Title", "Empty", "Subsection") in paths


def test_empty_markdown_returns_no_chunks():
    assert build_chunks("", max_tokens=600, overlap_tokens=0, breadcrumbs=True) == []
    assert build_chunks("   \n\n  ", max_tokens=600, overlap_tokens=0, breadcrumbs=True) == []


def test_chunk_indices_are_sequential():
    chunks = build_chunks(FIXTURE, max_tokens=120, overlap_tokens=0, breadcrumbs=False)

    assert [c.index for c in chunks] == list(range(len(chunks)))


def test_extract_title_reads_first_h1():
    assert extract_title(FIXTURE) == "Runbook: CrashLoopBackOff"


def test_extract_title_accepts_any_heading_level():
    # Docling starts a converted PDF with "## Title", so a document without an H1 used
    # to get the fallback title "Document <hash>" in the list and in search results.
    assert extract_title("## Runbook: Kafka consumer lag\n\nSymptoms...") == (
        "Runbook: Kafka consumer lag"
    )
    assert extract_title("### Details\n\nBody.") == "Details"


def test_extract_title_takes_the_first_heading_it_meets():
    markdown = "## Introduction\n\nBody.\n\n# A later H1\n\nMore."
    assert extract_title(markdown) == "Introduction"


def test_extract_title_ignores_hash_without_space():
    # "#tag" is not a heading in CommonMark.
    assert extract_title("#tag without a space\n\nBody.") is None


def test_extract_title_ignores_any_heading_inside_fence():
    markdown = "```yaml\n## not a title\n```\n\n## The real title\n\nBody."
    assert extract_title(markdown) == "The real title"


def test_extract_title_ignores_h1_inside_fence():
    markdown = "```\n# not a title\n```\n\n# The real title\n\nBody."
    assert extract_title(markdown) == "The real title"


def test_extract_title_missing():
    assert extract_title("a document without a heading") is None
    assert extract_title("") is None
