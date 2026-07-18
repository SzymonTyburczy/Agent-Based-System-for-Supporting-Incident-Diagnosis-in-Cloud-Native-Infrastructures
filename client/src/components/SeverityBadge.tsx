import type { Issue } from "../lib/types";

const severityStyles: Record<Issue["severity"], string> = {
  low: "bg-[var(--color-muted)]/15 text-[var(--color-muted)]",
  medium: "bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
  high: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  critical: "bg-[var(--color-danger)]/25 text-[var(--color-danger)]",
};

const severityLabel: Record<Issue["severity"], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export function SeverityBadge({ severity }: { severity: Issue["severity"] }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${severityStyles[severity]}`}
    >
      {severityLabel[severity]}
    </span>
  );
}
