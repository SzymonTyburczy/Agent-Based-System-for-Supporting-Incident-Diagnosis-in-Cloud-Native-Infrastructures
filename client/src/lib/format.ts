import { format, parseISO } from "date-fns";

export function formatIssueDate(iso: string): string {
  const date = parseISO(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, "dd/MM/yyyy, HH:mm");
}
