/**
 * Turning a report's `[KBn]` markers into citation chips. Pure: the report
 * components render the segments and links these functions produce.
 *
 * The marker grammar mirrors agent-core's `citations.py`. It canonicalises the
 * structured fields to `[KB1][KB3]`, but leaves `raw_diagnosis` (and `problem`
 * when structuring fell back to it) verbatim, while still collecting their
 * keys — so every variant it accepts there can reach this client.
 */

import { markdownLines } from "./markdownLines";
import type { DocCitation } from "./types";

const KEY_ATOM = String.raw`KB\s*\d+`;
const KEY_LIST = String.raw`\s*${KEY_ATOM}(?:\s*(?:[,;]\s*)?${KEY_ATOM})*\s*`;
// One marker group: [KB1], [ kb 1 ], (KB1), [KB1, KB3]. A bare KB1 is not a marker.
const MARKER = new RegExp(String.raw`\[${KEY_LIST}\]|\(${KEY_LIST}\)`, "gi");
const KEY_DIGITS = /KB\s*(\d+)/gi;
// A marker with the "!" that may precede it: "![1](…)" would be an image.
const BANG_MARKER = new RegExp(String.raw`(!?)(?:${MARKER.source})`, "gi");
// The text of an inline link or image, up to its "](": a chip inside it would
// be a link within a link, which CommonMark resolves by breaking the outer
// one. Allows one level of nested brackets, as a marker in it has.
const LINK_TEXT = /\[(?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*\]\(/g;

const HREF_PREFIX = "#cite-";

/** A run of plain text, or one known citation key with the number its chip shows. */
export type CitationSegment =
  { kind: "text"; text: string } | { kind: "cite"; citation: DocCitation; label: number };

interface Labelled {
  citation: DocCitation;
  label: number;
}

/** Canonical keys of one marker group, de-duplicated: "[kb01, KB1]" → ["KB1"]. */
function keysIn(marker: string): string[] {
  return [...new Set(Array.from(marker.matchAll(KEY_DIGITS), (m) => `KB${Number(m[1])}`))];
}

function keyedCitations(citations: DocCitation[]): Map<string, Labelled> {
  const byKey = new Map<string, Labelled>();
  citations.forEach((citation, i) => {
    if (citation.key !== null) byKey.set(citation.key, { citation, label: i + 1 });
  });
  return byKey;
}

/** The marker's known keys; an unknown one is dropped, as agent-core drops it
 * from the structured fields. Empty when none is known. */
function knownIn(marker: string, byKey: Map<string, Labelled>): Labelled[] {
  return keysIn(marker).flatMap((key) => byKey.get(key) ?? []);
}

/**
 * The number a citation's chip shows: its 1-based position in the report's
 * `citations` list, so the Sources card and the inline chips agree. Matched by
 * key, or by document for a whole-document citation; 0 when it is not in the
 * list at all.
 */
export function citationLabel(citations: DocCitation[], citation: DocCitation): number {
  return citations.findIndex((c) => c.key === citation.key && c.docId === citation.docId) + 1;
}

/**
 * Splits plain text into text runs and citation chips, for fields rendered as
 * text nodes (error sources, remediations, the raw diagnosis). A marker group
 * becomes one segment per known key; a marker with no known key stays text.
 */
export function splitCitationTokens(text: string, citations: DocCitation[]): CitationSegment[] {
  const byKey = keyedCitations(citations);
  const segments: CitationSegment[] = [];
  let copied = 0;

  for (const marker of text.matchAll(MARKER)) {
    const known = knownIn(marker[0], byKey);
    if (known.length === 0) continue;
    if (marker.index > copied) {
      segments.push({ kind: "text", text: text.slice(copied, marker.index) });
    }
    for (const { citation, label } of known) segments.push({ kind: "cite", citation, label });
    copied = marker.index + marker[0].length;
  }

  if (copied < text.length) segments.push({ kind: "text", text: text.slice(copied) });
  return segments;
}

/** `transform` applied to everything outside inline code spans: a backtick run
 * opens a span that only a run of the same length closes (CommonMark); an
 * unmatched run is literal text. */
function outsideCodeSpans(text: string, transform: (plain: string) => string): string {
  const runs = /`+/g;
  let out = "";
  let copied = 0;

  for (let open = runs.exec(text); open; open = runs.exec(text)) {
    const close = /`+/g;
    close.lastIndex = runs.lastIndex;
    let end = -1;
    for (let run = close.exec(text); run; run = close.exec(text)) {
      if (run[0].length === open[0].length) {
        end = close.lastIndex;
        break;
      }
    }
    if (end === -1) continue;
    out += transform(text.slice(copied, open.index)) + text.slice(open.index, end);
    copied = end;
    runs.lastIndex = end;
  }
  return out + transform(text.slice(copied));
}

/** Whether `text[index]` is backslash-escaped: preceded by an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (text[index - 1 - backslashes] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

/**
 * Rewrites every known marker in Markdown as links to its chips —
 * `[KB1]` → `[1](#cite-KB1)`, `[KB1, KB3]` → `[1](#cite-KB1)[3](#cite-KB3)` —
 * so the Markdown renderer can draw them (see `citationKeyFromHref`). Code
 * spans and fenced blocks are left alone: a `[KB1]` there is code. So is a
 * marker inside another link's text, where a chip would break that link.
 * Unknown markers stay as written.
 */
export function linkifyCitations(markdown: string, citations: DocCitation[]): string {
  const byKey = keyedCitations(citations);
  if (byKey.size === 0) return markdown;

  const linkify = (plain: string) => {
    const linkTexts = Array.from(plain.matchAll(LINK_TEXT), (m) => ({
      start: m.index,
      end: m.index + m[0].length,
    }));
    return plain.replace(BANG_MARKER, (match: string, bang: string, offset: number) => {
      const marker = match.slice(bang.length);
      const at = offset + bang.length;
      const known = knownIn(marker, byKey);
      if (known.length === 0) return match;
      if (linkTexts.some(({ start, end }) => start < at && at < end)) return match;
      const links = known
        .map(({ citation, label }) => `[${label}](${HREF_PREFIX}${citation.key})`)
        .join("");
      // "now![KB1]" must stay "now!" and a chip, not become an image.
      return (bang && !isEscaped(plain, offset) ? "\\!" : bang) + links;
    });
  };

  // Paragraph by paragraph: a code span cannot cross a blank line, so one
  // stray backtick must not hide the markers of the paragraphs after it.
  let out = "";
  let copied = 0;
  let paragraph: { start: number; end: number } | null = null;
  const flush = () => {
    if (paragraph === null) return;
    out +=
      markdown.slice(copied, paragraph.start) +
      outsideCodeSpans(markdown.slice(paragraph.start, paragraph.end), linkify);
    copied = paragraph.end;
    paragraph = null;
  };

  for (const line of markdownLines(markdown)) {
    if (line.inFence || line.text.trim() === "") {
      flush();
      continue;
    }
    const end = line.start + line.text.length;
    paragraph = paragraph === null ? { start: line.start, end } : { start: paragraph.start, end };
  }
  flush();
  return out + markdown.slice(copied);
}

/** The citation key a `linkifyCitations` link points at, or null for any other href. */
export function citationKeyFromHref(href: string | undefined): string | null {
  if (!href?.startsWith(HREF_PREFIX)) return null;
  return href.slice(HREF_PREFIX.length) || null;
}
