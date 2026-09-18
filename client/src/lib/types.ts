export type IssueStatus = "pending" | "resolved";
export type IssueSeverity = "low" | "medium" | "high" | "critical";

/**
 * List-view shape — exactly what `GET /reports` returns, and all the issues
 * grid and the dashboard counters need.
 */
export interface IssueSummary {
  id: string;
  title: string;
  service: string;
  severity: IssueSeverity;
  status: IssueStatus;
  /** The wire's `generated_at`: ISO-8601 UTC. May be unparseable — `formatIssueDate` renders "—". */
  createdAt: string;
  summary: string;
}

/**
 * Full report: `GET`/`PATCH /reports/{id}`, and every SSE event payload
 * (webhook_server.py publishes `ReportRecord.to_dict()` on both events, so a
 * stream event carries the whole detail, not just the summary fields).
 */
export interface IssueDetail extends IssueSummary {
  problem: string;
  errorSources: string[];
  remediations: string[];
  /** Verbatim LLM free text. Rendered as preformatted TEXT, never parsed as Markdown. */
  rawDiagnosis: string;
  /**
   * The backend-rendered Markdown document (`content_md`, built by
   * `report.py::render_report_markdown`). Deliberately NOT named `content`:
   * this client never parses or renders it — the UI builds its own
   * presentation from the structured fields above. It is the payload of the
   * "Copy Markdown" button and nothing else.
   */
  markdownExport: string;
}

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
