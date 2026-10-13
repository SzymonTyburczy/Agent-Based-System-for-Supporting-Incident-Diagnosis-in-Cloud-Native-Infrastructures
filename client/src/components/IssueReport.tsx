import {
  Fragment,
  useCallback,
  useMemo,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Crosshair,
  Library,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { MarkdownPreview } from "./MarkdownPreview";
import { EmptyCard } from "./Cards";
import { CitationChip, InlineCitation } from "./CitationChip";
import { useTransientFlag } from "../hooks/useTransientFlag";
import { citationLabel, linkifyCitations, splitCitationTokens } from "../lib/citations";
import { countLines } from "../lib/issueView";
import type { DocCitation } from "../lib/types";

/** What every section citing documentation needs: the report's sources and a way to open one. */
interface CitationProps {
  citations: DocCitation[];
  onOpenCitation: (citation: DocCitation) => void;
}

/**
 * Text with its `[KBn]` markers drawn as chips. The text runs stay text nodes —
 * this is how the plain-text fields get citations without going through a
 * Markdown parser.
 */
function CitedText({ text, citations, onOpenCitation }: { text: string } & CitationProps) {
  return splitCitationTokens(text, citations).map((segment, index) =>
    // Index keys: the segments are derived from one string and never reorder.
    segment.kind === "text" ? (
      <Fragment key={index}>{segment.text}</Fragment>
    ) : (
      <InlineCitation
        key={index}
        label={segment.label}
        onOpen={() => onOpenCitation(segment.citation)}
      />
    ),
  );
}

/**
 * Verbatim LLM free text, rendered as a text node — never through a Markdown
 * parser. CommonMark would collapse the model's single newlines into run-on
 * paragraphs, renumber its `1.` ordinals, turn any 4-space indent into a code
 * block, and let one unbalanced fence swallow the rest of the document.
 *
 * `[font-family:inherit]` undoes Tailwind preflight's mono stack for `pre`:
 * this content is English prose, not code, and the only thing the `<pre>` is
 * here for is whitespace fidelity. `[overflow-wrap:anywhere]` keeps a
 * 200-character pod name or image ref from pushing the page sideways.
 */
export function RawText({ text, ...citationProps }: { text: string } & CitationProps) {
  return (
    <pre className="[font-family:inherit] text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-[#e6ebf3]">
      <CitedText text={text} {...citationProps} />
    </pre>
  );
}

function SectionCard({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="card p-5 md:p-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
        <Icon className="h-4 w-4 text-[var(--color-brand)]" />
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[11px] font-normal text-[var(--color-muted)]">
            {count}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

export function ProblemSection({
  problem,
  isRaw,
  citations,
  onOpenCitation,
}: { problem: string; isRaw: boolean } & CitationProps) {
  // The Markdown path gets its chips as `#cite-KBn` links, which MarkdownPreview
  // turns back into buttons. Both memoised for MarkdownPreview's `memo`.
  const markdown = useMemo(() => linkifyCitations(problem, citations), [problem, citations]);
  const onCite = useCallback(
    (key: string) => {
      const citation = citations.find((c) => c.key === key);
      if (citation) onOpenCitation(citation);
    },
    [citations, onOpenCitation],
  );

  return (
    <SectionCard icon={Crosshair} title="Problem">
      {isRaw ? (
        <>
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            The agent's structuring step failed; the model's unstructured output is shown verbatim.
          </p>
          <RawText text={problem} citations={citations} onOpenCitation={onOpenCitation} />
        </>
      ) : (
        <MarkdownPreview content={markdown} size="base" source="agent" onCite={onCite} />
      )}
    </SectionCard>
  );
}

/**
 * Plain text nodes, not Markdown: these are one-line PromQL/LogQL fragments
 * and pod names that CommonMark would italicise on underscores
 * (`payments_api_pod`) and mangle on a stray backtick — and they are strings
 * the engineer copy-pastes.
 */
export function ErrorSourcesSection({
  items,
  ...citationProps
}: { items: string[] } & CitationProps) {
  return (
    <SectionCard icon={Search} title="Error sources" count={items.length}>
      <ul className="space-y-2">
        {items.map((item, index) => (
          // Index keys: LLM strings can repeat, and the list never reorders
          // within one report.
          <li
            key={index}
            className="flex items-start gap-2.5 rounded-lg bg-[var(--color-bg)] px-3 py-2 text-sm [overflow-wrap:anywhere]"
          >
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-brand)]" />
            {/* One flex item, however many chips the text holds. */}
            <span className="min-w-0">
              <CitedText text={item} {...citationProps} />
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

export function RemediationsSection({
  items,
  ...citationProps
}: { items: string[] } & CitationProps) {
  return (
    <SectionCard icon={Wrench} title="Suggested remediations" count={items.length}>
      {/* Numbered so they are addressable ("do 2 and 4"); as part of one
          Markdown blob they were bullets indistinguishable from the sources. */}
      <ol className="space-y-2.5">
        {items.map((item, index) => (
          <li key={index} className="flex items-start gap-2.5 text-sm [overflow-wrap:anywhere]">
            <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand)]/15 text-[11px] font-semibold text-[var(--color-brand)]">
              {index + 1}
            </span>
            <span className="min-w-0">
              <CitedText text={item} {...citationProps} />
            </span>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

/** The documents the diagnosis relied on, numbered as their chips in the text are. */
export function SourcesSection({ citations, onOpenCitation }: CitationProps) {
  return (
    <SectionCard icon={Library} title="Documentation sources" count={citations.length}>
      <ul className="flex flex-wrap gap-2">
        {citations.map((citation) => (
          <li key={`${citation.key ?? ""}:${citation.docId}`} className="max-w-full">
            <CitationChip
              citation={citation}
              label={citationLabel(citations, citation)}
              onOpen={onOpenCitation}
            />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

export function RawDiagnosisSection({
  text,
  defaultOpen,
  ...citationProps
}: { text: string; defaultOpen: boolean } & CitationProps) {
  const { flag: copied, trigger: markCopied } = useTransientFlag(2000);

  const copy = (event: MouseEvent) => {
    // Both are required: without them the click also toggles the <details>.
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard
      .writeText(text)
      .then(markCopied)
      .catch(() => {});
  };

  const lines = countLines(text);

  return (
    // Unstructured output doesn't deserve equal weight with the structured
    // findings, but it is the audit trail, so it stays one click away. The
    // collapse is also the containment for a 5000-line dump — which is why
    // the <pre> inside has no max-height and no scroller of its own.
    <details className="card group" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-sm font-semibold text-white [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 text-[var(--color-muted)] transition-transform group-open:rotate-90" />
        <Terminal className="h-4 w-4 text-[var(--color-brand)]" />
        Raw diagnosis
        <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[11px] font-normal text-[var(--color-muted)]">
          {lines} {lines === 1 ? "line" : "lines"}
        </span>
        <button onClick={copy} aria-label="Copy raw diagnosis" className="btn-secondary ml-auto">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </button>
      </summary>
      <div className="border-t border-[var(--color-border)] px-5 py-4">
        <RawText text={text} {...citationProps} />
      </div>
    </details>
  );
}

export function ReportEmptyState() {
  return <EmptyCard>The agent produced no readable content for this report.</EmptyCard>;
}
