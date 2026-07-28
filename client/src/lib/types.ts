export type IssueStatus = "pending" | "resolved";

export interface Issue {
  id: string;
  title: string;
  service: string;
  severity: "low" | "medium" | "high" | "critical";
  status: IssueStatus;
  createdAt: string;
  summary: string;
  /** Full issue report in Markdown, shown on the issue detail page. */
  content: string;
}

/** Issue shape without the full Markdown report — what list views (the
 * issues grid, dashboard counts) actually need, and all the agent's
 * `GET /reports` list endpoint returns (the full `content` only comes
 * back from `GET /reports/{id}`). */
export type IssueSummary = Omit<Issue, "content">;

/**
 * Payload sent to the backend after processing a document.
 * Field names are intentionally Polish per the agreed contract: data / autor / tresc
 * (date / author / content). `data` is a day-precision date (yyyy-MM-dd).
 */
export interface DocumentPayload {
  data: string;
  autor: string;
  tresc: string;
}

export type SourceFormat = "pdf" | "markdown" | "text";
