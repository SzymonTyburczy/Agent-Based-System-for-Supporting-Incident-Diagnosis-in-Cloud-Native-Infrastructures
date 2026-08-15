import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { SeverityBadge } from "../components/SeverityBadge";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyCard, ErrorCard, IssueMeta } from "../components/Cards";
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
      className="btn-secondary"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="hidden sm:inline">{copied ? "Copied" : "Copy Markdown"}</span>
    </button>
  );
}

export function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { detail, summary, status, error, retry, updating, updateError, toggleStatus } =
    useIssueDetail(id);

  // Whatever the list already cached paints the header immediately; the
  // detail request revalidates behind it.
  const head = detail ?? summary;

  if (status === "missing") {
    return (
      <div className="w-full pb-8">
        <BackLink />
        <EmptyCard>Issue {id} was not found.</EmptyCard>
      </div>
    );
  }

  if (!head) {
    return (
      <div className="w-full pb-8">
        <BackLink />
        {status === "error" ? (
          <ErrorCard title="Couldn't load this issue." detail={error} onRetry={retry} />
        ) : (
          <EmptyCard status>Loading issue…</EmptyCard>
        )}
      </div>
    );
  }

  const sections = detail ? deriveReportSections(detail) : null;

  return (
    <div className="w-full pb-8">
      <BackLink />

      {/* One centred column. Layout's <main> stays the app's only vertical
          scroller — no nested overflow region here, so find-in-page, deep
          links and scroll position all behave. */}
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
          meta={<IssueMeta service={head.service} createdAt={head.createdAt} />}
          actions={
            <>
              {detail?.markdownExport ? (
                <CopyMarkdownButton markdown={detail.markdownExport} />
              ) : null}
              <button onClick={toggleStatus} disabled={updating} className="btn-secondary">
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
          <ErrorCard title="Couldn't load the full report." detail={error} onRetry={retry} />
        ) : (
          <EmptyCard status>Loading the full report…</EmptyCard>
        )}
      </article>
    </div>
  );
}
