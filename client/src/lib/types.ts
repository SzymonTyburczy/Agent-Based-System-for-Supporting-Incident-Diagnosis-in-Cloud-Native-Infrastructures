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
  /** The knowledge-base documents the diagnosis relied on, in the report's own order. */
  citations: DocCitation[];
}

/**
 * One documentation source of a report, resolved by agent-core from the
 * `[KBn]` keys the LLM was handed (`agent_core/citations.py`), so `docId`
 * always names a document that was really retrieved.
 */
export interface DocCitation {
  /** "KB1"…, as it appears in the report text; null for a whole-document
   * citation (the report names the document but cites no passage of it). */
  key: string | null;
  docId: string;
  /** Never empty: the decoder falls back to the title, then to the doc id. */
  fileName: string;
  title: string;
  sectionPath: string[];
  chunkIndex: number | null;
  /** The cited chunk's text; null for a whole-document citation. */
  quote: string | null;
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
  /** The uploaded file's name (an additive, optional key of the same contract). */
  nazwa_pliku?: string;
}

/** One row of the knowledge base's `GET /api/documents` — metadata only, no text. */
export interface KbDocumentSummary {
  docId: string;
  title: string;
  /** Null for a document ingested before file names were recorded. */
  fileName: string | null;
  author: string;
  /** The ingest payload's `data`, yyyy-MM-dd. */
  docDate: string;
  chunkCount: number;
  /** ISO-8601, set by the server. */
  ingestedAt: string;
}

/** `GET /api/documents/{doc_id}`: the summary plus the full Markdown. */
export interface KbDocument extends KbDocumentSummary {
  content: string;
  /**
   * "reconstructed" for a document ingested before the server kept the
   * original: its text was stitched back together from the indexed chunks, so
   * it may not match the uploaded file exactly.
   */
  contentSource: "stored" | "reconstructed";
}

export type SourceFormat = "pdf" | "markdown" | "text";
