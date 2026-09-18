/**
 * The single decode boundary: the only place where `unknown` from the wire
 * becomes a domain object. Both the REST path (`api.ts`'s `request`, which
 * returns `unknown` so the compiler forces callers through here) and the SSE
 * path go through these functions, so hardening one hardens both.
 *
 * Pure by design — no React, no fetch, no `window` — so every decode rule
 * below is unit-testable without a DOM.
 */

import type { IssueDetail, IssueSeverity, IssueStatus, IssueSummary } from "./types";

type DecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

// Prometheus/Alertmanager severity labels aren't standardized across rule
// sets — this stack has been seen using at least these. `unknown` is
// agent-core's own fallback when an alert carries no severity label
// (incident.py::_UNKNOWN_LABEL), so it is a normal value, not an anomaly.
// Anything unrecognized lands on "medium" rather than "low", since an
// unfamiliar severity shouldn't read as reassuring.
const SEVERITY_MAP: Record<string, IssueSeverity> = {
  critical: "critical",
  page: "critical",
  high: "high",
  warning: "medium",
  medium: "medium",
  unknown: "medium",
  low: "low",
  info: "low",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The field when it is a usable string, else `fallback`. Not trimmed:
 * `problem` and `raw_diagnosis` carry meaningful internal whitespace, which
 * `deriveReportSections` normalizes at the view layer instead. */
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** Mirrors the backend's `report._as_string_list`: non-blank strings, trimmed. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function severity(value: unknown): IssueSeverity {
  return SEVERITY_MAP[text(value).trim().toLowerCase()] ?? "medium";
}

/** Trim-and-lowercase before comparing: an exact `=== "resolved"` turned
 * "Resolved" into *pending*, which is a claim about an incident rather than a
 * neutral default. */
function status(value: unknown): IssueStatus {
  return text(value).trim().toLowerCase() === "resolved" ? "resolved" : "pending";
}

/**
 * Fatal only for a non-object payload or a missing id: without an id a report
 * cannot be keyed, routed or PATCHed. Every other field is defaulted, because
 * dropping an incident is worse than rendering it with one field missing.
 */
function decodeSummary(input: unknown): DecodeResult<IssueSummary> {
  if (!isRecord(input)) {
    const got = input === null ? "null" : Array.isArray(input) ? "an array" : typeof input;
    return { ok: false, reason: `expected a JSON object, got ${got}` };
  }

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return { ok: false, reason: "record has no usable `id`" };

  return {
    ok: true,
    value: {
      id,
      title: text(input.title, "Untitled incident report"),
      service: text(input.service),
      severity: severity(input.severity),
      status: status(input.status),
      createdAt: text(input.generated_at),
      summary: text(input.summary),
    },
  };
}

export function parseReportDetail(
  input: unknown,
  source: "detail" | "stream",
): DecodeResult<IssueDetail> {
  const decoded = decodeSummary(input);
  if (!decoded.ok) return { ok: false, reason: `${source}: ${decoded.reason}` };

  const record = input as Record<string, unknown>;
  return {
    ok: true,
    value: {
      ...decoded.value,
      problem: text(record.problem),
      errorSources: stringList(record.error_sources),
      remediations: stringList(record.remediations),
      rawDiagnosis: text(record.raw_diagnosis),
      markdownExport: text(record.content_md),
    },
  };
}

/**
 * Decodes `GET /reports`, skipping bad rows rather than failing the batch: a
 * single malformed row used to throw inside `.map` and reject the whole
 * promise, wiping the issues grid AND both dashboard counters while telling
 * the user the agent was unreachable — even though it had answered.
 */
export function parseReportSummaryList(input: unknown): IssueSummary[] {
  if (!Array.isArray(input)) {
    console.warn("[idar/wire] expected an array of reports, got", input);
    return [];
  }

  const issues: IssueSummary[] = [];
  for (const row of input) {
    const result = decodeSummary(row);
    if (result.ok) issues.push(result.value);
    else console.warn("[idar/wire] skipped a report:", result.reason, row);
  }
  return issues;
}

export function toIssueSummary(detail: IssueDetail): IssueSummary {
  return {
    id: detail.id,
    title: detail.title,
    service: detail.service,
    severity: detail.severity,
    status: detail.status,
    createdAt: detail.createdAt,
    summary: detail.summary,
  };
}

/**
 * `origin` is a parameter rather than a `window.location` read so this stays
 * pure and testable in node — and so a relative `VITE_AGENT_API_URL` (e.g.
 * `/api` behind a Vite proxy) resolves instead of throwing `Invalid URL`.
 *
 * The token travels as a query param because `EventSource` cannot set custom
 * headers; agent-core's `require_client_token` accepts either.
 */
export function buildStreamUrl(baseUrl: string, token: string, origin: string): string {
  const url = new URL(`${baseUrl}/reports/stream`, origin);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
