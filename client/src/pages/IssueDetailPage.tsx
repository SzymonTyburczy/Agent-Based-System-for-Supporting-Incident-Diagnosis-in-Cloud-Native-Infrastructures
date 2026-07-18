import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Clock, ServerCog } from "lucide-react";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { ChatPanel } from "../components/ChatPanel";
import { SeverityBadge } from "../components/SeverityBadge";
import { StatusBadge } from "../components/StatusBadge";
import { mockIssues } from "../data/mockIssues";
import { formatIssueDate } from "../lib/format";

export function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const issue = mockIssues.find((i) => i.id === id);

  if (!issue) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-[var(--color-muted)]">Issue {id} was not found.</p>
        <Link
          to="/issues"
          className="flex items-center gap-1.5 text-sm text-[var(--color-brand)] hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Back to issues
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 shrink-0">
        <Link
          to="/issues"
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to issues
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-[var(--color-muted)]">{issue.id}</span>
          <SeverityBadge severity={issue.severity} />
          <StatusBadge status={issue.status} />
        </div>
        <h1 className="mt-2 text-xl font-semibold text-white">{issue.title}</h1>
        <div className="mt-1.5 flex items-center gap-4 text-xs text-[var(--color-muted)]">
          <span className="flex items-center gap-1">
            <ServerCog className="h-3.5 w-3.5" />
            {issue.service}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {formatIssueDate(issue.createdAt)}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
        {/* Left: issue report (markdown) */}
        <div className="card min-h-[320px] overflow-y-auto p-5 lg:h-full lg:w-1/2">
          <MarkdownPreview content={issue.content} />
        </div>

        {/* Right: AI chat. Height is capped below lg so the message list scrolls
            internally instead of stretching the page. key remounts the panel with
            fresh state when navigating between issues. */}
        <div className="flex h-[70dvh] min-h-[420px] flex-col lg:h-full lg:w-1/2">
          <ChatPanel key={issue.id} issueId={issue.id} />
        </div>
      </div>
    </div>
  );
}
