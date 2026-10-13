/**
 * Finding a cited passage inside its document, for the viewer's highlight.
 * Pure: offsets in, offsets out — the component decides what to paint.
 */

import { markdownLines } from "./markdownLines";

/**
 * A half-open range of UTF-16 offsets into a Markdown string: the unit of
 * remark's `node.position.*.offset`, so a range compares directly against the
 * rendered nodes of that same, unmodified string.
 */
export interface TextRange {
  start: number;
  end: number;
}

// A quote that is not found whole (cut short with an ellipsis, or diverging
// from the document further on) is looked up by its opening
// instead. Long enough to be unique in a document, short enough to stay
// inside the part that still matches.
const PREFIX_CHARS = 200;

// An ATX heading as the server's chunker reads it: at most three spaces of
// indent, 1-6 "#", then a space, a tab or the end of the line.
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/;
// The server starts a section only at H1-H3; deeper headings stay in its text.
const MAX_SECTION_LEVEL = 3;

/**
 * Removes the `"A > B\n\n"` breadcrumb the RAG server prepends to a chunk when
 * breadcrumbs are on, leaving the document's own text. Agent-core strips it
 * when it records a quote; stripping again here means finding the passage
 * does not depend on that.
 */
export function stripBreadcrumb(quote: string, sectionPath: string[]): string {
  if (sectionPath.length === 0) return quote;
  const prefix = `${sectionPath.join(" > ")}\n\n`;
  return quote.startsWith(prefix) ? quote.slice(prefix.length) : quote;
}

/** `source` with every whitespace run collapsed to one space (and none at either
 * end), plus the original offset of each character of the result. */
function collapseWhitespace(source: string): { text: string; offsets: Uint32Array } {
  // Typed array: 4 bytes per source character, where a number[] of a long
  // converted PDF would cost several times that.
  const offsets = new Uint32Array(source.length);
  const parts: string[] = [];
  let length = 0;

  for (const word of source.matchAll(/\S+/g)) {
    if (length > 0) {
      parts.push(" ");
      offsets[length++] = word.index - 1;
    }
    parts.push(word[0]);
    for (let i = 0; i < word[0].length; i++) offsets[length++] = word.index + i;
  }
  return { text: parts.join(""), offsets: offsets.subarray(0, length) };
}

/**
 * Where `quote` sits in `markdown`, compared with whitespace collapsed: chunk
 * text and the stored document can differ in line breaks and indentation, and
 * a reconstructed document joins its chunks with blank lines of its own. The
 * whole quote is tried first, then its opening, with the end placed one quote's
 * length further. First occurrence wins; null when neither is found.
 */
export function locateFragment(markdown: string, quote: string): TextRange | null {
  const needle = (quote.match(/\S+/g) ?? []).join(" ");
  if (!needle) return null;

  const haystack = collapseWhitespace(markdown);
  const toRange = (at: number, length: number): TextRange => ({
    start: haystack.offsets[at],
    end: haystack.offsets[at + length - 1] + 1,
  });

  const at = haystack.text.indexOf(needle);
  if (at !== -1) return toRange(at, needle.length);

  if (needle.length <= PREFIX_CHARS) return null;
  const prefixAt = haystack.text.indexOf(needle.slice(0, PREFIX_CHARS));
  if (prefixAt === -1) return null;
  return toRange(prefixAt, Math.min(needle.length, haystack.text.length - prefixAt));
}

/**
 * The heading line of the cited section, the viewer's fallback when the quote
 * itself cannot be found. Prefers the heading whose whole path matches —
 * runbooks repeat subheadings such as "Diagnosis" under every alert — and
 * otherwise takes the first heading named like the path's last element.
 * Headings inside fenced code are not headings. Null when nothing matches.
 */
export function findSectionHeading(markdown: string, sectionPath: string[]): TextRange | null {
  const target = sectionPath.at(-1);
  if (target === undefined) return null;

  // The H1-H3 headings enclosing the current line, as the server builds
  // `section_path`.
  const open: { level: number; text: string }[] = [];
  let firstByName: TextRange | null = null;

  for (const line of markdownLines(markdown)) {
    if (line.inFence) continue;
    const heading = ATX_HEADING.exec(line.text);
    if (!heading) continue;

    const level = heading[1].length;
    const text = (heading[2] ?? "").trim();
    const range = { start: line.start, end: line.start + line.text.length };

    if (level <= MAX_SECTION_LEVEL) {
      while (open.length > 0 && open[open.length - 1].level >= level) open.pop();
      open.push({ level, text });
      if (
        open.length === sectionPath.length &&
        open.every((entry, i) => entry.text === sectionPath[i])
      ) {
        return range;
      }
    }
    if (firstByName === null && text === target) firstByName = range;
  }
  return firstByName;
}
