import { CircleDot } from "lucide-react";
import type { IssueStatus } from "../lib/types";

const statusStyles: Record<IssueStatus, string> = {
  pending: "bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
  resolved: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
};

const statusLabel: Record<IssueStatus, string> = {
  pending: "Pending",
  resolved: "Resolved",
};

export function StatusBadge({ status }: { status: IssueStatus }) {
  return (
    // inline-flex, so pairing with SeverityBadge (a plain inline span) behaves
    // identically outside a flex parent.
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${statusStyles[status]}`}
    >
      <span className="sr-only">Status: </span>
      <CircleDot className="h-3 w-3" />
      {statusLabel[status]}
    </span>
  );
}
