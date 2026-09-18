import { useState } from "react";
import { Link } from "react-router-dom";
import { CircleDot } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { SeverityBadge } from "../components/SeverityBadge";
import { EmptyCard, ErrorCard, IssueMeta, StaleBanner } from "../components/Cards";
import { useReports } from "../hooks/useReports";
import type { IssueStatus, IssueSummary } from "../lib/types";

function IssueCard({ issue }: { issue: IssueSummary }) {
  return (
    <Link
      to={`/issues/${issue.id}`}
      className="card block p-4 transition-colors hover:border-[var(--color-brand)]/40"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-[var(--color-muted)]">{issue.id}</span>
        <SeverityBadge severity={issue.severity} />
      </div>
      <h3 className="mt-1.5 truncate text-sm font-semibold text-white">{issue.title}</h3>
      <p className="mt-2 line-clamp-2 text-xs text-[var(--color-muted)]">{issue.summary}</p>
      <div className="mt-3 flex items-center gap-4 text-[11px] text-[var(--color-muted)]">
        <IssueMeta service={issue.service} createdAt={issue.createdAt} />
      </div>
    </Link>
  );
}

export function IssuesPage() {
  const { issues, pending, resolved, loading, error, refresh } = useReports();
  const [tab, setTab] = useState<IssueStatus>("pending");

  const tabs: { key: IssueStatus; label: string; count: number }[] = [
    { key: "pending", label: "Pending", count: pending.length },
    { key: "resolved", label: "Resolved", count: resolved.length },
  ];

  const items = tab === "pending" ? pending : resolved;

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
            <CircleDot
              className={`h-4 w-4 ${key === "pending" ? "text-[var(--color-warning)]" : "text-[var(--color-success)]"}`}
            />
            {label}
            <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[11px]">
              {count}
            </span>
          </button>
        ))}
      </div>

      {/* A failed *refresh* must not throw away a list that is still on screen. */}
      {error && issues.length > 0 && (
        <StaleBanner
          message="Couldn't refresh from the diagnostic agent — this list may be stale."
          detail={error}
          onRetry={refresh}
        />
      )}

      {error && issues.length === 0 ? (
        <ErrorCard title="Couldn't reach the diagnostic agent." detail={error} onRetry={refresh} />
      ) : loading ? (
        <EmptyCard status>Loading issues…</EmptyCard>
      ) : items.length === 0 ? (
        <EmptyCard>No issues in this category.</EmptyCard>
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
