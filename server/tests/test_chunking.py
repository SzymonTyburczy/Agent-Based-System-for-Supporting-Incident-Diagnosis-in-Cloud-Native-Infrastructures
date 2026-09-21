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
        assert fences_balanced(chunk.text), f"przecięty płotek w chunku: {chunk.text!r}"


def test_oversized_fence_stays_whole():
    fence = (
        "```yaml\n"
        + "\n".join(f"klucz_{i}: wartosc_{i}" for i in range(60))
        + "\n\n# komentarz w YAML-u, nie nagłówek\n```"
    )
    markdown = f"# Tytuł\n\nWstęp przed blokiem.\n\n{fence}\n\nZakończenie po bloku."

    chunks = build_chunks(markdown, max_tokens=60, overlap_tokens=0, breadcrumbs=False)

    fence_chunks = [c for c in chunks if "```yaml" in c.text]
    assert len(fence_chunks) == 1
    assert fences_balanced(fence_chunks[0].text)
    assert "# komentarz w YAML-u, nie nagłówek" in fence_chunks[0].text


def test_section_paths_follow_header_tree():
    chunks = build_chunks(FIXTURE, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    paths = {c.section_path for c in chunks}
    assert ("Runbook: CrashLoopBackOff",) in paths
    assert ("Runbook: CrashLoopBackOff", "Diagnoza") in paths
    assert ("Runbook: CrashLoopBackOff", "Diagnoza", "Logi kontenera") in paths
    assert ("Runbook: CrashLoopBackOff", "Kody wyjścia") in paths


def test_breadcrumb_prefixes_chunk_text():
    chunks = build_chunks(FIXTURE, max_tokens=600, overlap_tokens=0, breadcrumbs=True)

    logs = [
        c
        for c in chunks
        if c.section_path == ("Runbook: CrashLoopBackOff", "Diagnoza", "Logi kontenera")
    ]
    assert logs
    assert logs[0].text.startswith("Runbook: CrashLoopBackOff > Diagnoza > Logi kontenera\n\n")


def test_breadcrumbs_can_be_disabled():
    chunks = build_chunks(FIXTURE, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    assert all(not c.text.startswith("Runbook: CrashLoopBackOff > ") for c in chunks)


def test_every_source_line_survives():
    chunks = build_chunks(FIXTURE, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    combined = "\n\n".join(c.text for c in chunks)
    for line in FIXTURE.splitlines():
        stripped = line.strip()
        if stripped:
            assert stripped in combined, f"zgubiona linia: {stripped!r}"


def test_long_section_respects_max_size():
    paragraphs = [
        f"Akapit numer {i}. " + "Diagnostyka wymaga cierpliwości i logów. " * 4 for i in range(15)
    ]
    markdown = "# Długi dokument\n\n## Sekcja\n\n" + "\n\n".join(paragraphs)
    max_tokens = 120

    chunks = build_chunks(markdown, max_tokens=max_tokens, overlap_tokens=0, breadcrumbs=False)

    max_chars = int(max_tokens * CHARS_PER_TOKEN)
    tail_allowance = int(MIN_CHUNK_TOKENS * CHARS_PER_TOKEN) + 2
    assert len(chunks) > 3
    assert all(len(c.text) <= max_chars + tail_allowance for c in chunks)


def test_giant_paragraph_is_sentence_split_with_overlap():
    sentences = [
        f"Zdanie numer {i} opisuje kolejny krok diagnostyki incydentu w klastrze."
        for i in range(30)
    ]
    markdown = "# Dokument\n\n" + " ".join(sentences)

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
    markdown = "# Dokument\n\n## Sekcja\n\n" + "A" * 415 + "\n\nKrótki ogon."

    chunks = build_chunks(markdown, max_tokens=120, overlap_tokens=0, breadcrumbs=False)

    assert len(chunks) == 1
    assert "Krótki ogon." in chunks[0].text


def test_header_only_section_produces_no_chunk():
    markdown = "# Tytuł\n\n## Pusta\n\n### Podsekcja\n\nTreść podsekcji."

    chunks = build_chunks(markdown, max_tokens=600, overlap_tokens=0, breadcrumbs=False)

    paths = [c.section_path for c in chunks]
    assert ("Tytuł", "Pusta") not in paths
    assert ("Tytuł", "Pusta", "Podsekcja") in paths


def test_empty_markdown_returns_no_chunks():
    assert build_chunks("", max_tokens=600, overlap_tokens=0, breadcrumbs=True) == []
    assert build_chunks("   \n\n  ", max_tokens=600, overlap_tokens=0, breadcrumbs=True) == []


def test_chunk_indices_are_sequential():
    chunks = build_chunks(FIXTURE, max_tokens=120, overlap_tokens=0, breadcrumbs=False)

    assert [c.index for c in chunks] == list(range(len(chunks)))


def test_extract_title_reads_first_h1():
    assert extract_title(FIXTURE) == "Runbook: CrashLoopBackOff"


def test_extract_title_ignores_h1_inside_fence():
    markdown = "```\n# to nie tytuł\n```\n\n# Prawdziwy tytuł\n\nTreść."
    assert extract_title(markdown) == "Prawdziwy tytuł"


def test_extract_title_missing():
    assert extract_title("dokument bez nagłówka") is None
    assert extract_title("") is None
