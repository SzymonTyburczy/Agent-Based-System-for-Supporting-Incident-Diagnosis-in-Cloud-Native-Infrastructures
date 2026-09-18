/**
 * Pure view derivation for the issue detail page: which sections exist, and
 * which of them must be rendered as preformatted text rather than Markdown.
 * No React, no formatting decisions — just the predicates, so they can be
 * pinned by tests instead of re-derived inside JSX.
 */

import type { IssueDetail } from "./types";

export interface ReportSections {
  /** CRLF→LF and surround-trimmed only; internal structure preserved byte-for-byte. */
  problem: string;
  /** `report.py` falls `problem` back to `raw_diagnosis` when structuring fails. */
  problemIsRaw: boolean;
  errorSources: string[];
  remediations: string[];
  rawDiagnosis: string;
  showRawDiagnosis: boolean;
  /** Open the disclosure when the raw dump is the only content there is. */
  rawDiagnosisOpen: boolean;
  isEmpty: boolean;
}

function norm(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function deriveReportSections(detail: IssueDetail): ReportSections {
  const problem = norm(detail.problem);
  const rawDiagnosis = norm(detail.rawDiagnosis);
  const { errorSources, remediations } = detail;

  // agent_core/report.py::parse_report_json sets `problem = fallback_diagnosis`
  // — the very string stored as `raw_diagnosis` — whenever the structuring
  // call returns something that isn't valid JSON. Rendering both would show
  // the reader the identical wall of text twice.
  const problemIsRaw = problem !== "" && problem === rawDiagnosis;
  const showRawDiagnosis = rawDiagnosis !== "" && !problemIsRaw;
  const hasStructured = problem !== "" || errorSources.length > 0 || remediations.length > 0;

  return {
    problem,
    problemIsRaw,
    errorSources,
    remediations,
    rawDiagnosis,
    showRawDiagnosis,
    rawDiagnosisOpen: showRawDiagnosis && !hasStructured,
    isEmpty:
      problem === "" &&
      rawDiagnosis === "" &&
      errorSources.length === 0 &&
      remediations.length === 0,
  };
}

export function countLines(text: string): number {
  const normalized = norm(text);
  if (normalized === "") return 0;
  return normalized.split("\n").length;
}
