export function formatIssueDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
