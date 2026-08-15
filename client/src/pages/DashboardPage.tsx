import { Link } from "react-router-dom";
import { CheckCircle2, Clock, FileText, RefreshCw, ShieldAlert } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { useReports } from "../hooks/useReports";

export function DashboardPage() {
  const { pending, resolved, loading, error, refresh } = useReports();
  // A failed fetch used to render a confident "0 pending issues" — in an
  // incident tool that is the opposite of the truth.
  const unavailable = loading || Boolean(error);

  const stats = [
    {
      label: "Pending issues",
      value: unavailable ? "—" : pending.length,
      icon: Clock,
      color: "text-[var(--color-warning)]",
    },
    {
      label: "Resolved issues",
      value: unavailable ? "—" : resolved.length,
      icon: CheckCircle2,
      color: "text-[var(--color-success)]",
    },
    {
      label: "Documents in knowledge base",
      value: "—",
      icon: FileText,
      color: "text-[var(--color-brand)]",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Overview of the system supporting incident diagnosis in cloud-native infrastructure."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--color-muted)]">{label}</span>
              <Icon className={`h-5 w-5 ${color}`} />
            </div>
            <div className="mt-3 text-3xl font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]"
        >
          Couldn't reach the diagnostic agent — issue counts are unavailable.
          <span className="text-xs text-[var(--color-muted)]">{error}</span>
          <button
            onClick={refresh}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-surface-2)]"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Link
          to="/documentation"
          className="card group p-6 transition-colors hover:border-[var(--color-brand)]/50"
        >
          <FileText className="h-6 w-6 text-[var(--color-brand)]" />
          <h3 className="mt-3 text-base font-semibold text-white">Add documentation</h3>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Upload PDF or Markdown to the RAG knowledge base. PDFs are converted to Markdown with
            Gemini.
          </p>
        </Link>

        <Link
          to="/issues"
          className="card group p-6 transition-colors hover:border-[var(--color-brand)]/50"
        >
          <ShieldAlert className="h-6 w-6 text-[var(--color-warning)]" />
          <h3 className="mt-3 text-base font-semibold text-white">Browse issues</h3>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            View incidents split into pending and resolved.
          </p>
        </Link>
      </div>
    </div>
  );
}
