/**
 * The single decode boundary: the only place where `unknown` from the wire
 * becomes a domain object. Both the REST path (`api.ts`'s `request`, which
 * returns `unknown` precisely so the compiler forces callers through here)
 * and the SSE path go through these functions, so hardening one hardens both.
 *
 * Pure by design — no React, no fetch, no `window` — so every decode rule
 * below is unit-testable without a DOM.
 *
 * Threat model, stated honestly: a healthy agent-core cannot emit a bad shape.
 * Every `/reports*` response goes through Pydantic (`reports_api.py` types
 * each field as a non-optional `str`/`list[str]`) and every column in
 * `reports_store.py`'s table is `NOT NULL`. This decoder is insurance against
 * a misconfigured base URL, a dev-server or reverse-proxy HTML fallback, a
 * stale build talking to a newer agent — and against the `as T` cast that
 * used to stand in for validation here.
 */

import type { IssueDetail, IssueSeverity, IssueStatus, IssueSummary } from "./types";

export type DecodeResult<T> =
  { ok: true; value: T; warnings: string[] } | { ok: false; reason: string };

export interface WireProblem {
  source: "list" | "detail" | "stream";
  /** dropped = the record was discarded; repaired = a field was defaulted. */
  kind: "dropped" | "repaired";
  /** null when the record had no usable id (i.e. every `dropped` case). */
  id: string | null;
  reason: string;
}

// Prometheus/Alertmanager severity labels aren't standardized across rule
// sets — this stack has been seen using at least these. Anything else
// (including "unknown", the extraction fallback in
// incident.extract_incident_meta_from_webhook) falls through to "medium"
// rather than silently becoming "low", since an unrecognized severity
// shouldn't read as reassuring.
const SEVERITY_MAP: Record<string, IssueSeverity> = {
  critical: "critical",
  page: "critical",
  high: "high",
  warning: "medium",
  medium: "medium",
  low: "low",
  info: "low",
};

const UNTITLED = "Untitled incident report";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the trimmed string, or null when the field is absent/not a string. */
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Mirrors the backend's `report._as_string_list`: keeps only non-blank
 * strings, trimmed. A non-array is not silently accepted.
 */
function asStringList(value: unknown): { list: string[]; repaired: boolean } {
  if (!Array.isArray(value)) return { list: [], repaired: true };
  const list = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return { list, repaired: list.length !== value.length };
}

function normalizeSeverity(value: unknown): { severity: IssueSeverity; repaired: boolean } {
  const raw = asString(value);
  if (raw === null) return { severity: "medium", repaired: true };
  const mapped = SEVERITY_MAP[raw.trim().toLowerCase()];
  return mapped ? { severity: mapped, repaired: false } : { severity: "medium", repaired: true };
}

/**
 * Trim-and-lowercase before comparing. The previous exact `raw === "resolved"`
 * turned "Resolved" and " resolved " into *pending* — a claim about an
 * incident, not a neutral default.
 */
function normalizeStatus(value: unknown): { status: IssueStatus; repaired: boolean } {
  const raw = asString(value);
  if (raw === null) return { status: "pending", repaired: true };
  return {
    status: raw.trim().toLowerCase() === "resolved" ? "resolved" : "pending",
    repaired: false,
  };
}

/**
 * A text field: kept verbatim when it is a usable string, defaulted to
 * `fallback` otherwise — and every default is recorded, so a report reading
 * "Untitled incident report" can explain itself instead of looking like a UI
 * bug. Not trimmed on the way through: `problem` and `raw_diagnosis` carry
 * meaningful internal whitespace, which `deriveReportSections` normalizes at
 * the view layer instead.
 */
function textField(
  input: Record<string, unknown>,
  key: string,
  warnings: string[],
  fallback = "",
): string {
  const value = asString(input[key]);
  if (value === null || value.trim() === "") {
    warnings.push(key);
    return fallback;
  }
  return value;
}

/**
 * Decodes the summary fields shared by every wire shape.
 *
 * Fatal (→ `ok: false`) only for a non-object payload or a missing/blank id:
 * without an id a report cannot be keyed, routed, deduped or PATCHed, so
 * there is nothing honest to do with it. Everything else is repaired and
 * reported through `warnings`, because dropping an incident is a worse
 * outcome than rendering it with a defaulted field.
 */
function decodeSummary(
  input: unknown,
):
  | { ok: false; reason: string }
  | { ok: true; value: IssueSummary; warnings: string[]; record: Record<string, unknown> } {
  if (!isRecord(input)) {
    return {
      ok: false,
      reason: `expected a JSON object, got ${input === null ? "null" : Array.isArray(input) ? "an array" : typeof input}`,
    };
  }

  const id = asString(input.id)?.trim();
  if (!id) {
    return { ok: false, reason: "record has no usable `id`" };
  }

  const warnings: string[] = [];
  const { severity, repaired: severityRepaired } = normalizeSeverity(input.severity);
  if (severityRepaired) warnings.push("severity");
  const { status, repaired: statusRepaired } = normalizeStatus(input.status);
  if (statusRepaired) warnings.push("status");

  const value: IssueSummary = {
    id,
    title: textField(input, "title", warnings, UNTITLED),
    service: textField(input, "service", warnings),
    severity,
    status,
    createdAt: textField(input, "generated_at", warnings),
    summary: textField(input, "summary", warnings),
  };

  return { ok: true, value, warnings, record: input };
}

export function parseReportSummary(input: unknown): DecodeResult<IssueSummary> {
  const decoded = decodeSummary(input);
  if (!decoded.ok) return decoded;
  return { ok: true, value: decoded.value, warnings: decoded.warnings };
}

export function parseReportDetail(
  input: unknown,
  source: WireProblem["source"],
): DecodeResult<IssueDetail> {
  const decoded = decodeSummary(input);
  if (!decoded.ok) return { ok: false, reason: `${source}: ${decoded.reason}` };

  const { record, warnings } = decoded;
  const errorSources = asStringList(record.error_sources);
  if (errorSources.repaired) warnings.push("error_sources");
  const remediations = asStringList(record.remediations);
  if (remediations.repaired) warnings.push("remediations");

  return {
    ok: true,
    value: {
      ...decoded.value,
      problem: textField(record, "problem", warnings),
      errorSources: errorSources.list,
      remediations: remediations.list,
      rawDiagnosis: textField(record, "raw_diagnosis", warnings),
      markdownExport: textField(record, "content_md", warnings),
    },
    warnings,
  };
}

/**
 * Decodes `GET /reports`. Skips bad rows instead of failing the batch: a
 * single malformed row used to throw inside `.map` and reject the whole
 * promise, wiping the issues grid AND both dashboard counters while telling
 * the user the agent was unreachable — even though it had answered.
 */
export function parseReportSummaryList(input: unknown): {
  issues: IssueSummary[];
  problems: WireProblem[];
} {
  if (!Array.isArray(input)) {
    return {
      issues: [],
      problems: [
        {
          source: "list",
          kind: "dropped",
          id: null,
          reason: `expected an array of reports, got ${input === null ? "null" : typeof input}`,
        },
      ],
    };
  }

  const issues: IssueSummary[] = [];
  const problems: WireProblem[] = [];
  for (const row of input) {
    const result = parseReportSummary(row);
    if (!result.ok) {
      problems.push({ source: "list", kind: "dropped", id: null, reason: result.reason });
      continue;
    }
    issues.push(result.value);
    for (const field of result.warnings) {
      problems.push({
        source: "list",
        kind: "repaired",
        id: result.value.id,
        reason: `defaulted \`${field}\``,
      });
    }
  }
  return { issues, problems };
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
 * pure and testable in vitest's node environment — and so a *relative*
 * `VITE_AGENT_API_URL` (e.g. `/api` behind a Vite proxy) resolves instead of
 * throwing `TypeError: Invalid URL` synchronously inside a render effect,
 * which is a config the fetch half of this module accepts perfectly well.
 *
 * The token travels as a query param because `EventSource` cannot set custom
 * request headers; agent-core's `require_client_token` accepts either.
 */
export function buildStreamUrl(baseUrl: string, token: string, origin: string): string {
  const url = new URL(`${baseUrl}/reports/stream`, origin);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
