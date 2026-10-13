import { FileText } from "lucide-react";
import { stripBreadcrumb } from "../lib/fragment";
import type { DocCitation } from "../lib/types";

// A tooltip, not a reading pane: enough of the passage to recognise it.
const QUOTE_PREVIEW_CHARS = 280;

function quotePreview(citation: DocCitation): string {
  if (citation.quote === null) return citation.title || citation.fileName;
  const text = stripBreadcrumb(citation.quote, citation.sectionPath).replace(/\s+/g, " ").trim();
  return text.length > QUOTE_PREVIEW_CHARS ? `${text.slice(0, QUOTE_PREVIEW_CHARS)}…` : text;
}

/**
 * One entry of a report's "Documentation sources": `[n] runbook.md` plus the
 * cited section, with the passage itself as the tooltip. A whole-document
 * citation has no number (no `[KBn]` marker in the text points at it) and no
 * section — just the file.
 */
export function CitationChip({
  citation,
  label,
  onOpen,
}: {
  citation: DocCitation;
  label: number;
  onOpen: (citation: DocCitation) => void;
}) {
  const keyed = citation.key !== null;
  const section = citation.sectionPath.join(" > ");

  return (
    <button
      type="button"
      onClick={() => onOpen(citation)}
      title={quotePreview(citation)}
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-left text-xs text-white transition-colors hover:border-[var(--color-brand)]/50"
    >
      {keyed ? (
        <span className="shrink-0 font-semibold text-[var(--color-brand)]">[{label}]</span>
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--color-brand)]" />
      )}
      {/* The section gives way first (a far larger shrink factor): the file
          is what identifies the source. */}
      <span className="max-w-64 min-w-0 truncate">{citation.fileName}</span>
      {keyed && section && (
        <span className="min-w-0 shrink-[100] truncate text-[var(--color-muted)]">{section}</span>
      )}
    </button>
  );
}

/**
 * The numbered chip inside report text where a `[KBn]` marker stood — the same
 * number as the source's entry in "Documentation sources".
 */
export function InlineCitation({ label, onOpen }: { label: number | string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Show the cited passage"
      // An aria-label rather than visually hidden text, which a reader
      // selecting and copying the sentence would pick up as well.
      aria-label={`Source ${label}`}
      className="mx-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded bg-[var(--color-brand)]/15 px-1 align-[0.1em] text-[11px] leading-[1.125rem] font-semibold text-[var(--color-brand)] transition-colors hover:bg-[var(--color-brand)]/30"
    >
      {label}
    </button>
  );
}
