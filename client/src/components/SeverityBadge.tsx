import type { IssueSeverity } from "../lib/types";

const severityStyles: Record<IssueSeverity, string> = {
  low: "bg-[var(--color-muted)]/15 text-[var(--color-muted)]",
  medium: "bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
  high: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  critical: "bg-[var(--color-danger)]/25 text-[var(--color-danger)]",
};

const severityLabel: Record<IssueSeverity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export function SeverityBadge({ severity }: { severity: IssueSeverity }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${severityStyles[severity]}`}
    >
      {/* Otherwise a screen reader announces a bare "HIGH". */}
      <span className="sr-only">Severity: </span>
      {severityLabel[severity]}
    </span>
  );
}
