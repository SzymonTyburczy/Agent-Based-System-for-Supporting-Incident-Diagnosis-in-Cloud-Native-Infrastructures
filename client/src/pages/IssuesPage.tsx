import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CircleDot, Clock, RefreshCw, ServerCog } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { SeverityBadge } from "../components/SeverityBadge";
import { useReports } from "../hooks/useReports";
import { formatIssueDate, formatUtcTimestamp } from "../lib/format";
import type { IssueStatus, IssueSummary } from "../lib/types";

function IssueCard({ issue }: { issue: IssueSummary }) {
  return (
    <Link
      to={`/issues/${issue.id}`}
      className="card block p-4 transition-colors hover:border-[var(--color-brand)]/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-[var(--color-muted)]">{issue.id}</span>
            <SeverityBadge severity={issue.severity} />
          </div>
          <h3 className="mt-1.5 truncate text-sm font-semibold text-white">{issue.title}</h3>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-[var(--color-muted)]">{issue.summary}</p>
      <div className="mt-3 flex items-center gap-4 text-[11px] text-[var(--color-muted)]">
        <span className="flex items-center gap-1">
          <ServerCog className="h-3.5 w-3.5" />
          {issue.service || "unknown service"}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          <time dateTime={issue.createdAt} title={formatUtcTimestamp(issue.createdAt)}>
            {formatIssueDate(issue.createdAt)}
          </time>
        </span>
      </div>
    </Link>
  );
}

/**
 * A silently short list is indistinguishable from a correct one, which is the
 * hardest failure to diagnose in a live panel. One line is enough — the full
 * reasons already go to console.warn.
 */
function WireNotice({ count, onReload }: { count: number; onReload: () => void }) {
  return (
    <p
      role="status"
      className="mb-4 rounded-xl border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-2 text-xs text-[var(--color-warning)]"
    >
      {count} report{count === 1 ? "" : "s"} from the agent couldn't be read and{" "}
      {count === 1 ? "isn't" : "aren't"} shown.
      <button onClick={onReload} className="ml-2 underline">
        Reload
      </button>
    </p>
  );
}

export function IssuesPage() {
  const { issues, pending, resolved, loading, error, problems, refresh } = useReports();
  const [tab, setTab] = useState<IssueStatus>("pending");

  const tabs: { key: IssueStatus; label: string; count: number }[] = [
    { key: "pending", label: "Pending", count: pending.length },
    { key: "resolved", label: "Resolved", count: resolved.length },
  ];

  const items = tab === "pending" ? pending : resolved;
  const droppedCount = problems.filter((problem) => problem.kind === "dropped").length;

  return (
    <div>
      <PageHeader
        title="Issues"
        description="Overview of incidents split into pending and resolved, synced live from the diagnostic agent."
      />

      <div className="mb-5 inline-flex rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
        {tabs.map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={[
              "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
              tab === key
                ? "bg-[var(--color-surface-2)] text-white"
                : "text-[var(--color-muted)] hover:text-white",
            ].join(" ")}
          >
            {key === "pending" ? (
              <CircleDot className="h-4 w-4 text-[var(--color-warning)]" />
            ) : (
              <CircleDot className="h-4 w-4 text-[var(--color-success)]" />
            )}
            {label}
            <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[11px]">
              {count}
            </span>
          </button>
        ))}
      </div>

      {droppedCount > 0 && <WireNotice count={droppedCount} onReload={refresh} />}

      {/* A failed *refresh* must not throw away a list that is still on screen
          — the reducer deliberately preserves `issues` for exactly this. Only
          take over the viewport when there is genuinely nothing to show. */}
      {error && issues.length > 0 && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-2 text-xs text-[var(--color-danger)]"
        >
          Couldn't refresh from the diagnostic agent — this list may be stale.
          <span className="text-[var(--color-muted)]">{error}</span>
          <button
            onClick={refresh}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1 font-medium text-white transition-colors hover:bg-[var(--color-surface-2)]"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      )}

      {error && issues.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 border-[var(--color-danger)]/40 py-16 text-center">
          <AlertTriangle className="h-5 w-5 text-[var(--color-danger)]" />
          <p className="text-sm text-[var(--color-danger)]">Couldn't reach the diagnostic agent.</p>
          <p className="text-xs text-[var(--color-muted)]">{error}</p>
          <button
            onClick={refresh}
            className="mt-2 flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-surface-2)]"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      ) : loading ? (
        <div className="card flex flex-col items-center justify-center border-dashed py-16 text-center">
          <p className="text-sm text-[var(--color-muted)]">Loading issues…</p>
        </div>
      ) : items.length === 0 ? (
        <div className="card flex flex-col items-center justify-center border-dashed py-16 text-center">
          <p className="text-sm text-[var(--color-muted)]">No issues in this category.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {items.map((issue) => (
            <IssueCard key={issue.id} issue={issue} />
          ))}
        </div>
      )}
    </div>
  );
}
