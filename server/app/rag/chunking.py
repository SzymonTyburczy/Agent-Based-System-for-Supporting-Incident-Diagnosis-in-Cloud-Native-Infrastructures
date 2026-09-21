import re
from dataclasses import dataclass

from langchain_text_splitters import MarkdownHeaderTextSplitter

# Heurystyka 3,5 znaku/token: polski jest mniej efektywny tokenowo niż angielski,
# a precyzja nie ma znaczenia przy kontekście 32k tokenów modelu.
CHARS_PER_TOKEN = 3.5
MIN_CHUNK_TOKENS = 50

_HEADERS_TO_SPLIT_ON = [("#", "h1"), ("##", "h2"), ("###", "h3")]
_FENCE_RE = re.compile(r"^(`{3,}|~{3,})")
_H1_RE = re.compile(r"^#\s+(.+?)\s*$")
_HEADING_ONLY_RE = re.compile(r"^#{1,6}\s+\S[^\n]*$")
_SENTENCE_ENDS = (". ", "! ", "? ", "\n")


@dataclass(frozen=True)
class Chunk:
    text: str
    section_path: tuple[str, ...]
    index: int


def extract_title(markdown: str) -> str | None:
    in_fence = False
    for line in markdown.splitlines():
        if _FENCE_RE.match(line.strip()):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = _H1_RE.match(line)
        if match:
            return match.group(1)
    return None


def _is_atomic(unit: str) -> bool:
    # Bloków kodu i tabel nigdy nie tniemy — przecięty YAML czy tabela
    # są bezwartościowe i przy wyszukiwaniu, i dla czytającego agenta.
    return bool(_FENCE_RE.match(unit)) or unit.lstrip().startswith("|")


def _split_units(text: str) -> list[str]:
    """Dzieli tekst sekcji na jednostki pakowania: bloki kodu w całości,
    proza po pustych liniach. Pustych linii wewnątrz płotka nie wolno
    traktować jak granic akapitów — stąd parser liniowy zamiast splitu."""
    units: list[str] = []
    prose_lines: list[str] = []
    fence_lines: list[str] = []
    in_fence = False

    def flush_prose() -> None:
        joined = "\n".join(prose_lines)
        prose_lines.clear()
        for paragraph in re.split(r"\n\s*\n", joined):
            if paragraph.strip():
                units.append(paragraph.strip("\n"))

    for line in text.splitlines():
        if _FENCE_RE.match(line.strip()):
            if in_fence:
                fence_lines.append(line)
                units.append("\n".join(fence_lines))
                fence_lines.clear()
                in_fence = False
            else:
                flush_prose()
                fence_lines.append(line)
                in_fence = True
        elif in_fence:
            fence_lines.append(line)
        else:
            prose_lines.append(line)

    if in_fence:
        units.append("\n".join(fence_lines))
    else:
        flush_prose()
    return units


def _sentence_split(paragraph: str, max_chars: int, overlap_chars: int) -> list[str]:
    pieces: list[str] = []
    start = 0
    while start < len(paragraph):
        end = min(start + max_chars, len(paragraph))
        if end < len(paragraph):
            window = paragraph[start:end]
            cut = max(window.rfind(mark) for mark in _SENTENCE_ENDS)
            if cut > max_chars // 2:
                end = start + cut + 1
        pieces.append(paragraph[start:end].strip())
        if end >= len(paragraph):
            break
        overlap_start = end - overlap_chars
        boundary = paragraph.rfind(". ", overlap_start, end)
        next_start = boundary + 2 if boundary != -1 else overlap_start
        start = next_start if next_start > start else end
    return [piece for piece in pieces if piece]


def _pack(units: list[str], max_chars: int, min_chars: int) -> list[str]:
    chunks: list[str] = []
    current = ""
    for unit in units:
        candidate = f"{current}\n\n{unit}" if current else unit
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = unit
        else:
            current = candidate
    if current:
        chunks.append(current)

    if len(chunks) > 1 and len(chunks[-1]) < min_chars:
        tail = chunks.pop()
        chunks[-1] = f"{chunks[-1]}\n\n{tail}"
    return chunks


def build_chunks(
    markdown: str,
    *,
    max_tokens: int,
    overlap_tokens: int,
    breadcrumbs: bool,
) -> list[Chunk]:
    max_chars = int(max_tokens * CHARS_PER_TOKEN)
    overlap_chars = int(overlap_tokens * CHARS_PER_TOKEN)
    min_chars = int(MIN_CHUNK_TOKENS * CHARS_PER_TOKEN)

    splitter = MarkdownHeaderTextSplitter(_HEADERS_TO_SPLIT_ON, strip_headers=False)
    sections = splitter.split_text(markdown)

    chunks: list[Chunk] = []
    for section in sections:
        content = section.page_content.strip()
        # Sam nagłówek bez treści nie tworzy chunka — jego tekst i tak niosą
        # section_path chunków podsekcji.
        if not content or _HEADING_ONLY_RE.fullmatch(content):
            continue
        path = tuple(section.metadata[key] for key in ("h1", "h2", "h3") if key in section.metadata)

        expanded: list[str] = []
        for unit in _split_units(content):
            if len(unit) > max_chars and not _is_atomic(unit):
                expanded.extend(_sentence_split(unit, max_chars, overlap_chars))
            else:
                expanded.append(unit)

        for text in _pack(expanded, max_chars, min_chars):
            if breadcrumbs and path:
                text = f"{' > '.join(path)}\n\n{text}"
            chunks.append(Chunk(text=text, section_path=path, index=len(chunks)))
    return chunks
