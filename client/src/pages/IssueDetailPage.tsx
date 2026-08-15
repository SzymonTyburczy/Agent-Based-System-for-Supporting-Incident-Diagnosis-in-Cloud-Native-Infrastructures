import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Check, Clock, Copy, RefreshCw, ServerCog } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { SeverityBadge } from "../components/SeverityBadge";
import { StatusBadge } from "../components/StatusBadge";
import {
  ErrorSourcesSection,
  ProblemSection,
  RawDiagnosisSection,
  RemediationsSection,
  ReportEmptyState,
} from "../components/IssueReport";
import { useIssueDetail } from "../hooks/useIssueDetail";
import { useTransientFlag } from "../hooks/useTransientFlag";
import { deriveReportSections } from "../lib/issueView";
import { formatIssueDate, formatUtcTimestamp } from "../lib/format";

const SECONDARY_BUTTON =
  "flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-50";

function BackLink() {
  return (
    <Link
      to="/issues"
      className="mb-4 inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-white"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> Back to issues
    </Link>
  );
}

/**
 * Reachable from two places on purpose: the cold case (nothing cached, so it
 * takes the whole page) and the warm case (a cached summary paints the header
 * while the detail request fails). Keying the error UI on `!head` alone hid it
 * on the common list→detail click, leaving a placeholder that never resolved.
 */
function LoadErrorCard({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="card flex flex-col items-center gap-2 border-[var(--color-danger)]/40 py-16 text-center"
    >
      <AlertTriangle className="h-5 w-5 text-[var(--color-danger)]" />
      <p className="text-sm text-[var(--color-danger)]">Couldn't load the full report.</p>
      <p className="text-xs text-[var(--color-muted)]">{message}</p>
      <button onClick={onRetry} className={`mt-2 ${SECONDARY_BUTTON}`}>
        <RefreshCw className="h-3.5 w-3.5" /> Retry
      </button>
    </div>
  );
}

function CopyMarkdownButton({ markdown }: { markdown: string }) {
  const { flag: copied, trigger: markCopied } = useTransientFlag(2000);
  return (
    <button
      onClick={() =>
        void navigator.clipboard
          .writeText(markdown)
          .then(markCopied)
          .catch(() => {})
      }
      // The visible label is hidden below `sm`, and lucide marks its icons
      // aria-hidden — without this the button announces as just "button".
      aria-label="Copy Markdown"
      className={SECONDARY_BUTTON}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="hidden sm:inline">{copied ? "Copied" : "Copy Markdown"}</span>
    </button>
  );
}

export function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { detail, summary, status, error, problems, retry, updating, updateError, toggleStatus } =
    useIssueDetail(id);

  // Whatever the list already cached paints the header immediately; the
  // detail request revalidates behind it.
  const head = detail ?? summary;

  if (status === "missing") {
    return (
      <div className="w-full pb-8">
        <BackLink />
        <div className="card flex flex-col items-center justify-center border-dashed py-16 text-center">
          <p className="text-sm text-[var(--color-muted)]">Issue {id} was not found.</p>
        </div>
      </div>
    );
  }

  if (status === "error" && !head) {
    return (
      <div className="w-full pb-8">
        <BackLink />
        <LoadErrorCard message={error} onRetry={retry} />
      </div>
    );
  }

  if (!head) {
    return (
      <div className="w-full pb-8">
        <BackLink />
        <div
          role="status"
          className="card flex flex-col items-center justify-center border-dashed py-16 text-center"
        >
          <p className="text-sm text-[var(--color-muted)]">Loading issue…</p>
        </div>
      </div>
    );
  }

  const sections = detail ? deriveReportSections(detail) : null;
  // Deduplicated: the same field is typically repaired twice for one report —
  // once decoding the list row, once decoding the detail.
  const repairedFields = [
    ...new Set(
      problems.filter((problem) => problem.kind === "repaired").map((problem) => problem.reason),
    ),
  ];

  return (
    <div className="w-full pb-8">
      <BackLink />

      {/* One centred column. Layout's <main> stays the app's only vertical
          scroller — no nested overflow region here, so find-in-page, deep
          links and scroll position all behave. Width knob: max-w-none for
          literal edge-to-edge, max-w-3xl for the tightest reading measure. */}
      <article className="mx-auto w-full max-w-4xl">
        <PageHeader
          eyebrow={
            <>
              <span className="font-mono text-sm text-[var(--color-muted)]">{head.id}</span>
              <SeverityBadge severity={head.severity} />
              <StatusBadge status={head.status} />
            </>
          }
          title={head.title}
          description={head.summary}
          meta={
            <>
              <span className="flex items-center gap-1">
                <ServerCog className="h-3.5 w-3.5" />
                {head.service || "unknown service"}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                <time dateTime={head.createdAt} title={formatUtcTimestamp(head.createdAt)}>
                  {formatIssueDate(head.createdAt)}
                </time>
              </span>
            </>
          }
          actions={
            <>
              {detail?.markdownExport ? (
                <CopyMarkdownButton markdown={detail.markdownExport} />
              ) : null}
              <button onClick={toggleStatus} disabled={updating} className={SECONDARY_BUTTON}>
                {updating ? "Updating…" : head.status === "pending" ? "Mark resolved" : "Reopen"}
              </button>
            </>
          }
        />

        {updateError && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]"
          >
            {updateError}
          </div>
        )}

        {repairedFields.length > 0 && (
          // So a report reading "Untitled incident report" explains itself
          // instead of looking like a UI bug.
          <p
            role="status"
            className="mb-4 rounded-xl border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-2 text-xs text-[var(--color-warning)]"
          >
            Some fields from the agent were incomplete: {repairedFields.join(", ")}.
          </p>
        )}

        {sections ? (
          <div className="space-y-4">
            {sections.problem && (
              <ProblemSection problem={sections.problem} isRaw={sections.problemIsRaw} />
            )}
            {sections.errorSources.length > 0 && (
              <ErrorSourcesSection items={sections.errorSources} />
            )}
            {sections.remediations.length > 0 && (
              <RemediationsSection items={sections.remediations} />
            )}
            {sections.showRawDiagnosis && (
              <RawDiagnosisSection
                text={sections.rawDiagnosis}
                defaultOpen={sections.rawDiagnosisOpen}
              />
            )}
            {sections.isEmpty && <ReportEmptyState />}
          </div>
        ) : status === "error" ? (
          // The header is painted from the cached summary, but the detail
          // request failed — say so instead of spinning forever.
          <LoadErrorCard message={error} onRetry={retry} />
        ) : (
          <div
            role="status"
            className="card flex flex-col items-center justify-center border-dashed py-16 text-center"
          >
            <p className="text-sm text-[var(--color-muted)]">Loading the full report…</p>
          </div>
        )}
      </article>
    </div>
  );
}
