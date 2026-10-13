/**
 * Line scanning shared by `fragment.ts` and `citations.ts`: both need to know
 * which lines of a Markdown document are code, and both report positions as
 * offsets into the original string.
 *
 * The fence rules mirror the RAG server's chunker (`server/app/rag/chunking.py`)
 * rather than full CommonMark, so a heading the server put into a chunk's
 * `section_path` is a heading here too.
 */

export interface MarkdownLine {
  /** The line without its terminator. */
  text: string;
  /** Offset of the line's first character in the source string. */
  start: number;
  /** True for every line of a fenced code block, both fence lines included. */
  inFence: boolean;
}

// The server's line endings: CommonMark's three, not every Unicode separator.
const LINE_END = /\r\n?|\n/g;
// After backticks the info string may not hold a backtick (CommonMark):
// "```kubectl get pods```" alone on a line is inline code, not a fence that
// swallows the rest of the document.
const FENCE_OPEN = /^(`{3,}(?!.*`)|~{3,})/;

/** Only a fence of the same character and at least as long closes the block,
 * so a ``` line inside a ```` block (a Markdown example) is content. */
function closesFence(trimmed: string, opening: string): boolean {
  return trimmed.length >= opening.length && trimmed === opening[0].repeat(trimmed.length);
}

/** Splits `markdown` into lines, marking fenced code. An unclosed fence runs to the end. */
export function markdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let fence: string | null = null;
  let start = 0;

  for (;;) {
    LINE_END.lastIndex = start;
    const terminator = LINE_END.exec(markdown);
    const end = terminator ? terminator.index : markdown.length;
    const text = markdown.slice(start, end);
    const trimmed = text.trim();

    if (fence !== null) {
      lines.push({ text, start, inFence: true });
      if (closesFence(trimmed, fence)) fence = null;
    } else {
      const opening = FENCE_OPEN.exec(trimmed);
      if (opening) fence = opening[1];
      lines.push({ text, start, inFence: opening !== null });
    }

    if (!terminator) return lines;
    start = LINE_END.lastIndex;
  }
}
