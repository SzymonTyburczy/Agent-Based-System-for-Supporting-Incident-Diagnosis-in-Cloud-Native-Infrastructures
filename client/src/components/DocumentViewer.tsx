import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { FileText, X } from "lucide-react";
import { MarkdownPreview } from "./MarkdownPreview";
import { EmptyCard, ErrorCard } from "./Cards";
import { useDocument } from "../hooks/useDocuments";
import {
  findSectionHeading,
  locateFragment,
  stripBreadcrumb,
  type TextRange,
} from "../lib/fragment";
import type { DocCitation } from "../lib/types";

// Tailwind's `xl`, where the viewer sits beside the page instead of under it.
const SIDE_BY_SIDE = "(min-width: 80rem)";
// Room left above the highlighted block: a sliver of what precedes it tells
// the reader the document goes on above.
const SCROLL_MARGIN_PX = 32;

interface CitationTarget {
  range: TextRange | null;
  /** The citation pointed somewhere, and neither its passage nor its section was found. */
  missed: boolean;
}

/**
 * Where to point the reader: the cited passage, else its section's heading,
 * else nothing (the top). A whole-document citation points nowhere by design,
 * which is not a miss.
 */
function locateCitation(content: string, citation: DocCitation | null): CitationTarget {
  if (!citation) return { range: null, missed: false };
  const quote =
    citation.quote === null ? "" : stripBreadcrumb(citation.quote, citation.sectionPath);
  const range =
    (quote ? locateFragment(content, quote) : null) ??
    findSectionHeading(content, citation.sectionPath);
  return { range, missed: range === null && (quote !== "" || citation.sectionPath.length > 0) };
}

/**
 * One knowledge-base document beside the page that opened it — a report
 * citing it, or the knowledge-base list. The panel is deliberately a second
 * scroll container (viewport-tall and sticky at `xl`), so the passage can be
 * scrolled to without moving the page around it.
 *
 * `nonce` changes on every open, including a second click on the same chip,
 * which scrolls back to the passage after the reader has scrolled away.
 */
export function DocumentViewer({
  docId,
  citation = null,
  nonce,
  onClose,
}: {
  docId: string;
  citation?: DocCitation | null;
  nonce: number;
  onClose: () => void;
}) {
  // `doc`, not `document`: the global is too close at hand to shadow.
  const { document: doc, status, error, retry } = useDocument(docId);
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const content = doc?.content ?? "";
  // Memoised: a fresh range object on every render would defeat
  // MarkdownPreview's `memo` and re-parse the whole document.
  const { range: highlight, missed } = useMemo(
    () => locateCitation(content, citation),
    [content, citation],
  );

  // Inside the panel only: `scrollIntoView` would also scroll <main>, pulling
  // the report out from under the reader at `xl`. Re-runs on a new document,
  // a new passage, or another click on the same chip (`nonce`).
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || status !== "ready") return;
    const block = container.querySelector<HTMLElement>("[data-cite-highlight]");
    const offset = block
      ? block.getBoundingClientRect().top - container.getBoundingClientRect().top
      : null;
    container.scrollTo({
      top: offset === null ? 0 : Math.max(0, container.scrollTop + offset - SCROLL_MARGIN_PX),
    });
  }, [docId, status, highlight, nonce]);

  // Not on a deep link (nonce 0): nothing was clicked to open it, and Layout
  // resets <main> to the top on arrival anyway.
  useEffect(() => {
    if (nonce === 0) return;
    // The panel comes after the whole page in tab order: move focus to it so
    // a keyboard or screen-reader user lands on the document (Close, or
    // Back, hands focus back — see useDocumentPanel). Without scrolling: at
    // `xl` that would move the page beside the sticky panel.
    headingRef.current?.focus({ preventScroll: true });
    // Below `xl` the panel stacks under the page, possibly a long way down —
    // bring it into view when the reader asks for it.
    if (window.matchMedia(SIDE_BY_SIDE).matches) return;
    panelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [nonce]);

  const name = doc ? doc.fileName || doc.title || doc.docId : (citation?.fileName ?? "Document");

  return (
    <aside
      ref={panelRef}
      aria-label={`Document: ${name}`}
      className="card flex h-[80vh] min-h-[420px] flex-col overflow-hidden xl:sticky xl:top-8 xl:h-[calc(100vh-4rem)]"
    >
      <header className="flex items-start gap-3 border-b border-[var(--color-border)] px-5 py-4">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-brand)]" />
        <div className="min-w-0 flex-1">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-sm font-semibold text-white"
            title={name}
          >
            {name}
          </h2>
          {doc?.title && doc.title !== name && (
            <p className="truncate text-xs text-[var(--color-muted)]" title={doc.title}>
              {doc.title}
            </p>
          )}
          {status === "ready" && doc?.contentSource === "reconstructed" && (
            <p className="mt-1 text-[11px] text-[var(--color-warning)]">
              Reconstructed from its indexed fragments — this document was added before originals
              were kept, so its layout may differ from the uploaded file.
            </p>
          )}
        </div>
        <button onClick={onClose} aria-label="Close document" className="btn-secondary">
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {status === "missing" ? (
          <EmptyCard>This document is no longer in the knowledge base.</EmptyCard>
        ) : status === "error" ? (
          <ErrorCard title="Couldn't load this document." detail={error} onRetry={retry} />
        ) : !doc ? (
          <EmptyCard status>Loading the document…</EmptyCard>
        ) : (
          <>
            {missed && (
              <p role="status" className="mb-3 text-xs text-[var(--color-muted)]">
                Couldn't find the cited passage — showing the whole document.
              </p>
            )}
            <MarkdownPreview content={content} source="knowledge-base" highlight={highlight} />
          </>
        )}
      </div>
    </aside>
  );
}
