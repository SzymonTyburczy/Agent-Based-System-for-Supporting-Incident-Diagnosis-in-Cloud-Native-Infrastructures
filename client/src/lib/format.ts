import { format, parseISO } from "date-fns";

export function formatIssueDate(iso: string): string {
  const date = parseISO(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, "dd/MM/yyyy, HH:mm");
}

/**
 * The same instant in UTC, for the `title` of the `<time>` element whose
 * visible text is browser-local. `generated_at` is UTC on the wire
 * (`%Y-%m-%dT%H:%M:%SZ`, see report.py::save_report), and a timestamp shown
 * in local time with nothing saying so is ambiguous in an incident tool.
 *
 * Implemented with UTC getters rather than date-fns so the output does not
 * depend on the host timezone.
 */
export function formatUtcTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}
