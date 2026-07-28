import { useState } from "react";
import { Link } from "react-router-dom";
<<<<<<< HEAD
import { AlertTriangle, CircleDot, Clock, ServerCog } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { SeverityBadge } from "../components/SeverityBadge";
import { useReports } from "../hooks/useReports";
import { formatIssueDate } from "../lib/format";
import type { IssueStatus, IssueSummary } from "../lib/types";

function IssueCard({ issue }: { issue: IssueSummary }) {
=======
import { CircleDot, Clock, ServerCog } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { SeverityBadge } from "../components/SeverityBadge";
import { mockIssues } from "../data/mockIssues";
import { formatIssueDate } from "../lib/format";
import type { Issue, IssueStatus } from "../lib/types";

const grouped = {
  pending: mockIssues.filter((i) => i.status === "pending"),
  resolved: mockIssues.filter((i) => i.status === "resolved"),
};

function IssueCard({ issue }: { issue: Issue }) {
>>>>>>> main
  return (
    <Link
      to={`/issues/${issue.id}`}
      className="block rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-brand)]/40"
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
          {issue.service}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          {formatIssueDate(issue.createdAt)}
        </span>
      </div>
    </Link>
  );
}

export function IssuesPage() {
  const { issues, loading, error } = useReports();
  const [tab, setTab] = useState<IssueStatus>("pending");

  const grouped = {
    pending: issues.filter((i) => i.status === "pending"),
    resolved: issues.filter((i) => i.status === "resolved"),
  };

  const tabs: { key: IssueStatus; label: string; count: number }[] = [
    { key: "pending", label: "Pending", count: grouped.pending.length },
    { key: "resolved", label: "Resolved", count: grouped.resolved.length },
  ];

  const items = grouped[tab];

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

      {error ? (
        <div className="card flex flex-col items-center gap-2 border-[var(--color-danger)]/40 py-16 text-center">
          <AlertTriangle className="h-5 w-5 text-[var(--color-danger)]" />
          <p className="text-sm text-[var(--color-danger)]">Couldn't reach the diagnostic agent.</p>
          <p className="text-xs text-[var(--color-muted)]">{error}</p>
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
