import { Link } from "react-router-dom";
import { CheckCircle2, Clock, FileText, ShieldAlert } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { StaleBanner } from "../components/Cards";
import { useReports } from "../hooks/useReports";

export function DashboardPage() {
  const { issues, pending, resolved, loading, error, refresh } = useReports();
  // A failed fetch used to render a confident "0 pending issues" — in an
  // incident tool that is the opposite of the truth. But once counts ARE
  // known, a failed background refresh must not blank them either: the banner
  // below already says they may be stale, which beats "—" on top of real data.
  const unavailable = loading || (Boolean(error) && issues.length === 0);

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
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Overview of the system supporting incident diagnosis in cloud-native infrastructure."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        <div className="mt-4">
          <StaleBanner
            message={
              issues.length === 0
                ? "Couldn't reach the diagnostic agent — issue counts are unavailable."
                : "Couldn't refresh from the diagnostic agent — these counts may be stale."
            }
            detail={error}
            onRetry={refresh}
          />
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
