import re
from dataclasses import dataclass

# 3.5 characters per token: Polish is less token-efficient than English, and
# precision does not matter with the model's 32k-token context.
CHARS_PER_TOKEN = 3.5
MIN_CHUNK_TOKENS = 50

# H1-H3 start a section; deeper headings stay in their section's text.
_MAX_SECTION_LEVEL = 3
_FENCE_RE = re.compile(r"^(`{3,}|~{3,})")
# A line that opens a code block. After backticks the info string may not hold a
# backtick (CommonMark): "```kubectl get pods```" alone on a line is inline code,
# and taken for a fence it would swallow the rest of the document, headings
# included. Possessive, so a long run of backticks is not rescanned.
_FENCE_OPEN_RE = re.compile(r"^(`{3,}+(?!.*`)|~{3,})")
# Only CommonMark's line endings: str.splitlines() also breaks at form feeds,
# U+2028 and the like, which made lines (and, after a "# ", headings) that the
# source does not have out of text pasted from a PDF or Word.
_LINE_END_RE = re.compile(r"\r\n?|\n")
# Any heading level, not just H1: Docling starts a converted PDF with "## Title",
# and a document without an H1 used to get the fallback title "Document <hash>".
_HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$")
# An ATX heading as CommonMark has it: at most three spaces of indent (four make
# an indented code block, where "# ..." is a shell or YAML comment), then 1-6
# "#" followed by a space, a tab or the end of the line. The text is stripped
# by the caller: a lazy group before "\s*$" backtracks quadratically on a long
# run of spaces, and this pattern runs on every line of the document.
_ATX_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})(?:[ \t](.*))?$")
_SENTENCE_END_RE = re.compile(r"[.!?] |\n")
_OVERLAP_START_RE = re.compile(r"\. |\n")
# "23. " opening an ordered-list item: its ". " ends no sentence.
_LIST_MARKER_RE = re.compile(r"^[ \t]*\d{1,9}\. ", re.MULTILINE)


@dataclass(frozen=True)
class Chunk:
    text: str
    section_path: tuple[str, ...]
    index: int


def extract_title(markdown: str) -> str | None:
    """The document's first heading, whatever its level: what a reader sees at
    the top of the page."""
    in_fence = False
    for line in markdown.splitlines():
        if _FENCE_RE.match(line.strip()):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = _HEADING_RE.match(line)
        if match:
            return match.group(1)
    return None


def _line_kind(line: str) -> str:
    stripped = line.strip()
    if not stripped:
        return "blank"
    if _FENCE_OPEN_RE.match(stripped):
        return "fence"
    if stripped.startswith("|"):
        return "table"
    if _ATX_HEADING_RE.match(line):
        return "heading"
    return "text"


def _fence_end(lines: list[str], start: int) -> int:
    """Index just past the line that closes the code block opened at
    lines[start]. Only a fence of the same character and at least as long
    closes it, so a ``` line inside a ```` block (a Markdown example) is
    content; an unclosed block runs to the end of the text."""
    opening = _FENCE_OPEN_RE.match(lines[start].strip()).group(1)
    for i in range(start + 1, len(lines)):
        closing = lines[i].strip()
        if closing.startswith(opening) and set(closing) == {opening[0]}:
            return i + 1
    return len(lines)


def _is_heading_only(lines: list[str]) -> bool:
    return all(not line.strip() or _ATX_HEADING_RE.match(line) for line in lines)


def _split_sections(markdown: str) -> list[tuple[tuple[str, ...], list[str]]]:
    """Splits the document at the H1-H3 headings outside code blocks into
    (section_path, lines) pairs; a section starts with its own heading line and
    keeps every line verbatim. Our own parser rather than LangChain's
    MarkdownHeaderTextSplitter: that one strips every line, code blocks
    included, and drops tabs and blank lines, so the agent got YAML without its
    indentation and the packer had no paragraph breaks to work with."""
    sections: list[tuple[tuple[str, ...], list[str]]] = [((), [])]
    open_headings: list[tuple[int, str]] = []
    # A byte order mark is no text: left in, it hides the "#" of the first heading.
    lines = _LINE_END_RE.split(markdown.removeprefix("\ufeff"))
    i = 0
    while i < len(lines):
        if _line_kind(lines[i]) == "fence":
            end = _fence_end(lines, i)
            sections[-1][1].extend(lines[i:end])
            i = end
            continue
        heading = _ATX_HEADING_RE.match(lines[i])
        if heading and len(heading.group(1)) <= _MAX_SECTION_LEVEL:
            level = len(heading.group(1))
            while open_headings and open_headings[-1][0] >= level:
                open_headings.pop()
            open_headings.append((level, (heading.group(2) or "").strip()))
            sections.append((tuple(text for _, text in open_headings), []))
        sections[-1][1].append(lines[i])
        i += 1
    return sections


def _split_units(lines: list[str]) -> list[tuple[str, bool]]:
    """Splits a section into packing units, each a verbatim run of its lines:
    a code block or a table whole, prose a paragraph at a time. Returns
    (text, atomic) pairs; atomic units are never split, since half a YAML block
    or half a table is worthless both for search and for the agent reading it."""
    blocks: list[tuple[int, int, str]] = []
    i = 0
    while i < len(lines):
        kind = _line_kind(lines[i])
        start = i
        if kind == "fence":
            i = _fence_end(lines, start)
        else:
            # Prose runs to a blank line, but a table or a heading needs no blank
            # line around it, so its lines always make a block of their own.
            i += 1
            while i < len(lines) and _line_kind(lines[i]) == kind:
                i += 1
        if kind != "blank":
            blocks.append((start, i, kind))

    units: list[tuple[str, bool]] = []
    held: int | None = None
    for start, end, kind in blocks:
        # Headings wait for the block below them: a chunk of headings alone
        # says nothing, and the content after it would lose its title. That
        # includes a heading right under a line of text (it may interrupt a
        # paragraph), hence a block of its own rather than the end of the text.
        if kind == "heading":
            held = start if held is None else held
            continue
        if held is not None:
            start, held = held, None
        units.append(("\n".join(lines[start:end]), kind != "text"))
    if held is not None:
        units.append(("\n".join(lines[held : blocks[-1][1]]), False))
    return units


def _sentence_split(paragraph: str, max_chars: int, overlap_chars: int) -> list[str]:
    # The ". " of a list marker is no sentence end: cut there, a piece ends with
    # a lone "23." and the overlap shrinks to that number.
    markers = {m.end() - 2 for m in _LIST_MARKER_RE.finditer(paragraph)}

    def boundaries(pattern: re.Pattern[str], pos: int, endpos: int) -> list[re.Match[str]]:
        found = pattern.finditer(paragraph, pos, endpos)
        return [m for m in found if m.start() not in markers]

    pieces: list[str] = []
    start = 0
    while start < len(paragraph):
        end = min(start + max_chars, len(paragraph))
        clean_cut = True
        if end < len(paragraph):
            cuts = boundaries(_SENTENCE_END_RE, start, end)
            clean_cut = bool(cuts) and cuts[-1].start() - start > max_chars // 2
            if clean_cut:
                end = cuts[-1].start() + 1
        piece = paragraph[start:end]
        # A piece that starts a line keeps its indentation (a nested list item,
        # a stack trace line); anywhere else the cut leaves stray spaces.
        at_line_start = start == 0 or paragraph[start - 1] == "\n"
        pieces.append(piece.rstrip() if at_line_start else piece.strip())
        if end >= len(paragraph):
            break
        # The overlap restarts at a sentence or a line start: list items and
        # log lines have no ". " to restart at, and a piece that starts
        # mid-word reads as garbage. A line longer than the overlap (a JSON log
        # line) has neither, so a clean cut is kept at the cost of the overlap.
        overlap_start = end - overlap_chars
        restarts = boundaries(_OVERLAP_START_RE, overlap_start, end - 1)
        if restarts:
            next_start = restarts[-1].end()
        else:
            next_start = end if clean_cut else overlap_start
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

    chunks: list[Chunk] = []
    for path, lines in _split_sections(markdown):
        # A heading with no body makes no chunk: the section_path of its
        # subsections' chunks carries its text anyway.
        if _is_heading_only(lines):
            continue

        expanded: list[str] = []
        for unit, atomic in _split_units(lines):
            if len(unit) > max_chars and not atomic:
                expanded.extend(_sentence_split(unit, max_chars, overlap_chars))
            else:
                expanded.append(unit)

        for text in _pack(expanded, max_chars, min_chars):
            if breadcrumbs and path:
                text = f"{' > '.join(path)}\n\n{text}"
            chunks.append(Chunk(text=text, section_path=path, index=len(chunks)))
    return chunks
