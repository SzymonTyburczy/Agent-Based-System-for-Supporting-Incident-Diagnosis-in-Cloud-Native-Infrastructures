import re
import time
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


def test_hash_lines_in_code_are_not_headings():
    # A ``` line does not close a ```` fence (a Markdown example), and four
    # spaces of indent make an indented code block, not a heading.
    example = "````markdown\n```bash\n# install the agent\n```\n## Not a section either\n````"
    indented = "    # restart the pod\n    kubectl delete pod api-0"
    markdown = f"# Runbook\n\n## Setup\n\n{example}\n\n{indented}\n\nAfter the examples."

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert [c.section_path for c in chunks] == [("Runbook", "Setup")]
    assert example in chunks[0].text
    assert indented in chunks[0].text


def test_tilde_fence_is_a_code_block():
    # Only a fence of the same character closes it: the ``` line is content.
    fence = "~~~yaml\n# replicas for the demo\nspec:\n  replicas: 2\n```\n~~~"
    markdown = f"# Runbook\n\n## Scaling\n\n{fence}\n\nApply it with kubectl."

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert [c.section_path for c in chunks] == [("Runbook", "Scaling")]
    assert chunks[0].text == f"## Scaling\n\n{fence}\n\nApply it with kubectl."


def test_triple_backtick_inline_code_is_not_a_fence():
    # A backtick fence's info string may not hold a backtick (CommonMark): this
    # line is inline code, and as a fence it would swallow "## Fix".
    markdown = (
        "# Runbook\n\n## Diagnosis\n\nRun this:\n\n```kubectl get pods```\n\n"
        "## Fix\n\nRestart the deployment."
    )

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert [(c.section_path, c.text) for c in chunks] == [
        (("Runbook", "Diagnosis"), "## Diagnosis\n\nRun this:\n\n```kubectl get pods```"),
        (("Runbook", "Fix"), "## Fix\n\nRestart the deployment."),
    ]


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

    chunk_lines = {line for c in chunks for line in c.text.splitlines()}
    for line in FIXTURE.splitlines():
        if line.strip():
            assert line in chunk_lines, f"lost or altered line: {line!r}"


def test_fenced_yaml_keeps_its_indentation():
    chunks = build_chunks(FIXTURE, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    yaml_block = re.search(r"```yaml\n.*?\n```", FIXTURE, re.DOTALL).group(0)
    yaml_chunks = [c for c in chunks if "```yaml" in c.text]
    assert len(yaml_chunks) == 1
    assert '\nresources:\n  limits:\n    memory: "512Mi"\n' in yaml_chunks[0].text
    assert yaml_block in yaml_chunks[0].text


def test_tabs_survive_in_code_block():
    output = "NAME\tREADY\tSTATUS\napi-7f9c\t0/1\tCrashLoopBackOff"
    markdown = f"# Pods\n\n```\n{output}\n```"

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert len(chunks) == 1
    assert output in chunks[0].text


def test_text_before_first_heading_has_empty_section_path():
    preamble = "  Owner: SRE team\n  Escalation: the on-call channel"
    markdown = f"{preamble}\n\n# Runbook\n\nBody."

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=True)

    assert chunks[0].section_path == ()
    assert chunks[0].text == preamble
    assert chunks[1].section_path == ("Runbook",)


def test_only_real_line_endings_split_lines():
    # A form feed (a page break pasted from a PDF) and U+2028 (pasted from Word)
    # belong to their line, so "# not a heading" opens no section; "\r\n" from
    # a Windows editor is still a line ending.
    body = "Intro # not a heading more text\n\npage one\x0cpage two"
    markdown = f"# Runbook\r\n\r\n{body}"

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert [(c.section_path, c.text) for c in chunks] == [(("Runbook",), f"# Runbook\n\n{body}")]


def test_byte_order_mark_does_not_hide_the_first_heading():
    markdown = "﻿# Runbook\n\n## Fix\n\nRestart the deployment."

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert [(c.section_path, c.text) for c in chunks] == [
        (("Runbook", "Fix"), "## Fix\n\nRestart the deployment.")
    ]


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


def test_paragraphs_are_packed_whole():
    paragraphs = [
        f"Step {i} of the procedure. Check the pod events. Compare them with the logs."
        for i in range(12)
    ]
    markdown = "# Runbook\n\n" + "\n\n".join(paragraphs)

    chunks = build_chunks(markdown, max_tokens=60, overlap_tokens=0, breadcrumbs=False)

    assert len(chunks) > 2
    packed = [part for c in chunks for part in c.text.split("\n\n")]
    assert packed == ["# Runbook", *paragraphs]


def test_table_directly_under_heading_stays_whole_with_its_heading():
    rows = "\n".join(f"| {code} | meaning of exit code {code} |" for code in range(1, 40))
    table = f"| Code | Meaning |\n| ---- | ------- |\n{rows}"
    markdown = f"# Runbook\n\nIntro paragraph.\n\n## Exit codes\n{table}\n\n## Next\n\nMore."
    max_tokens = 60

    chunks = build_chunks(markdown, max_tokens=max_tokens, overlap_tokens=0, breadcrumbs=False)

    assert len(table) > max_tokens * CHARS_PER_TOKEN
    exit_codes = [c for c in chunks if c.section_path == ("Runbook", "Exit codes")]
    assert [c.text for c in exit_codes] == [f"## Exit codes\n{table}"]


def test_headings_are_never_a_chunk_on_their_own():
    fence = "```yaml\n" + "\n".join(f"key_{i}: value_{i}" for i in range(60)) + "\n```"
    section = f"## Configuration\n\n#### Full manifest\n\n{fence}"
    markdown = f"# Runbook\n\nIntro paragraph.\n\n{section}"

    chunks = build_chunks(markdown, max_tokens=60, overlap_tokens=0, breadcrumbs=False)

    config = [c for c in chunks if c.section_path == ("Runbook", "Configuration")]
    assert [c.text for c in config] == [section]


def test_heading_right_under_text_starts_the_chunk_of_its_content():
    # No blank line before "#### Events" (a heading may interrupt a paragraph):
    # it still belongs to the list below it, not to the end of the logs above.
    logs = "\n".join(
        f"2026-10-12T10:0{i}:00Z kubelet Back-off restarting failed container api" for i in range(3)
    )
    events = "\n".join(
        f"- Warning BackOff {i}: Back-off restarting failed container" for i in range(5)
    )
    markdown = f"# Runbook\n\n## Diagnosis\n\n{logs}\n#### Events\n\n{events}"

    chunks = build_chunks(markdown, max_tokens=60, overlap_tokens=0, breadcrumbs=False)

    assert len(chunks) > 1
    assert any(c.text.startswith("#### Events\n\n- Warning BackOff 0:") for c in chunks)
    assert not any(c.text.endswith("#### Events") for c in chunks)


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


def test_overlap_restarts_at_a_line_start():
    # Log lines and stack traces have no ". " to restart the overlap at.
    lines: list[str] = []
    for i in range(15):
        lines.append(f"2026-10-12T10:{i:02d}:00Z ERROR pod/checkout-{i} java.lang.OutOfMemoryError")
        lines.append(f"\tat com.example.checkout.Cart.load(Cart.java:{100 + i})")
    markdown = "# Incident log\n\n" + "\n".join(lines)

    chunks = build_chunks(markdown, max_tokens=120, overlap_tokens=30, breadcrumbs=False)

    assert len(chunks) > 2
    for chunk in chunks:
        assert set(chunk.text.splitlines()) <= {"# Incident log", "", *lines}
    for i in range(len(chunks) - 1):
        assert chunks[i + 1].text.splitlines()[0] in chunks[i].text.splitlines()


def test_ordered_list_is_split_between_items():
    # "23. " is a list marker, not the end of a sentence: cut there, a piece
    # ended with a lone "23." and the overlap held only that number.
    items = [
        f"{n}. Run kubectl describe pod checkout-{n} -n otel-demo and read its events"
        for n in range(1, 60)
    ]
    markdown = "## Steps\n\n" + "\n".join(items)

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=80, breadcrumbs=False)

    assert len(chunks) > 2
    for chunk in chunks:
        assert set(chunk.text.splitlines()) <= {"## Steps", "", *items}
    for i in range(len(chunks) - 1):
        assert chunks[i + 1].text.splitlines()[0] in chunks[i].text.splitlines()


def test_overlap_does_not_restart_inside_a_line_longer_than_it():
    # A JSON log line is longer than the overlap and holds no ". ": with no
    # boundary to restart at, the next piece starts at the clean cut instead.
    lines = [
        f'{{"ts": "2026-10-12T10:{i:02d}:00Z", "level": "error", "pod": "frontend-{i}", '
        f'"msg": "upstream connect error or disconnect/reset before headers", "attempt": {i}}}'
        for i in range(30)
    ]
    markdown = "## Logs\n\n" + "\n".join(lines)
    overlap_tokens = 30

    chunks = build_chunks(
        markdown, max_tokens=120, overlap_tokens=overlap_tokens, breadcrumbs=False
    )

    assert len(lines[0]) > overlap_tokens * CHARS_PER_TOKEN
    assert len(chunks) > 2
    for chunk in chunks:
        assert set(chunk.text.splitlines()) <= {"## Logs", "", *lines}


def test_tiny_tail_is_merged_into_previous_chunk():
    # The heading and the paragraph nearly fill the 420-character budget, so the
    # tail is packed on its own and then merged back.
    paragraph = "A" * 400
    markdown = "# Document\n\n## Section\n\n" + paragraph + "\n\nShort tail."

    chunks = build_chunks(markdown, max_tokens=120, overlap_tokens=0, breadcrumbs=False)

    assert len(chunks) == 1
    assert chunks[0].text == f"## Section\n\n{paragraph}\n\nShort tail."


def test_header_only_section_produces_no_chunk():
    markdown = "# Title\n\n## Empty\n\n### Subsection\n\nSubsection body."

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    paths = [c.section_path for c in chunks]
    assert ("Title", "Empty") not in paths
    assert ("Title", "Empty", "Subsection") in paths


def test_level_four_heading_stays_in_its_section():
    section = (
        "## Diagnosis\n\nCheck the pod.\n\n"
        "#### Events\n\n- FailedScheduling\n  - Insufficient memory"
    )
    markdown = f"# Runbook\n\n{section}"

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert [(c.section_path, c.text) for c in chunks] == [(("Runbook", "Diagnosis"), section)]


def test_heading_with_a_long_run_of_spaces_is_parsed_quickly():
    # The heading pattern runs on every line; its old form backtracked
    # quadratically over a run of spaces and took seconds on this line.
    line = "#### a" + " " * 50_000 + "b"
    markdown = f"# Runbook\n\nIntro.\n\n{line}"

    started = time.perf_counter()
    build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert time.perf_counter() - started < 1


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
