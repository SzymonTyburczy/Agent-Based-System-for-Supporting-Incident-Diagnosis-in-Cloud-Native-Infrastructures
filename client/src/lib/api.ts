import { getAgentApiToken, getAgentApiUrl } from "./settings";
import type { Issue, IssueStatus, IssueSummary } from "./types";

/**
 * Wire shapes returned by agent-core's /reports* endpoints
 * (agent_core/reports_api.py). Kept separate from the app's own `Issue`
 * type: `severity`/`status` here are free-form strings straight from
 * Alertmanager labels and the store, not the app's closed unions, so they
 * go through `toIssueSummary`/`toIssue` below rather than being trusted
 * as-is.
 */
interface RawReportSummary {
  id: string;
  generated_at: string;
  title: string;
  service: string;
  severity: string;
  status: string;
  summary: string;
}

interface RawReportDetail extends RawReportSummary {
  problem: string;
  error_sources: string[];
  remediations: string[];
  raw_diagnosis: string;
  content_md: string;
}

// Prometheus/Alertmanager severity labels aren't standardized across rule
// sets — this stack has been seen using at least these. Anything else
// (including "unknown", the extraction fallback in
// incident.extract_incident_meta_from_webhook) falls through to "medium"
// rather than silently becoming "low", since an unrecognized severity
// shouldn't read as reassuring.
const SEVERITY_MAP: Record<string, Issue["severity"]> = {
  critical: "critical",
  page: "critical",
  high: "high",
  warning: "medium",
  medium: "medium",
  low: "low",
  info: "low",
};

function normalizeSeverity(raw: string): Issue["severity"] {
  return SEVERITY_MAP[raw.toLowerCase()] ?? "medium";
}

function normalizeStatus(raw: string): IssueStatus {
  return raw === "resolved" ? "resolved" : "pending";
}

function toIssueSummary(raw: RawReportSummary): IssueSummary {
  return {
    id: raw.id,
    title: raw.title,
    service: raw.service,
    severity: normalizeSeverity(raw.severity),
    status: normalizeStatus(raw.status),
    createdAt: raw.generated_at,
    summary: raw.summary,
  };
}

function toIssue(raw: RawReportDetail): Issue {
  return {
    ...toIssueSummary(raw),
    content: raw.content_md,
  };
}

class AgentApiError extends Error {}

function authHeaders(): HeadersInit {
  const token = getAgentApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getAgentApiUrl();
  if (!baseUrl) {
    throw new AgentApiError(
      "VITE_AGENT_API_URL is not set — point it at agent-core's webhook_server (see .env.example).",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...init?.headers },
    });
  } catch {
    throw new AgentApiError(`Could not reach the diagnostic agent at ${baseUrl}.`);
  }

  if (!response.ok) {
    throw new AgentApiError(`Agent API request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function fetchIssues(status?: IssueStatus): Promise<IssueSummary[]> {
  const query = status ? `?status=${status}` : "";
  const raw = await request<RawReportSummary[]>(`/reports${query}`);
  return raw.map(toIssueSummary);
}

export async function fetchIssue(id: string): Promise<Issue> {
  const raw = await request<RawReportDetail>(`/reports/${id}`);
  return toIssue(raw);
}

export async function updateIssueStatus(id: string, status: IssueStatus): Promise<Issue> {
  const raw = await request<RawReportDetail>(`/reports/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  return toIssue(raw);
}

export type ReportStreamEvent =
  | { type: "report_created"; issue: IssueSummary }
  | { type: "report_updated"; issue: IssueSummary };

/**
 * Subscribes to agent-core's SSE stream (GET /reports/stream) for live
 * updates on top of the initial `fetchIssues()` load. Returns an
 * unsubscribe function; call it on unmount.
 *
 * Connection problems are reported through `onError` rather than thrown —
 * this runs detached from any particular render, and the browser's
 * EventSource already retries the connection on its own, so a transient
 * drop shouldn't be treated as fatal by the caller.
 */
export function subscribeToReportEvents(
  onEvent: (event: ReportStreamEvent) => void,
  onError?: () => void,
): () => void {
  const baseUrl = getAgentApiUrl();
  if (!baseUrl) {
    onError?.();
    return () => {};
  }

  // EventSource can't set custom headers, so when an API token is
  // configured it travels as a query param instead (agent-core's
  // require_client_token accepts either — see webhook_server.py). Fine
  // for a local dev tool talking to a local agent; if this ever needs to
  // leave localhost, swap for a short-lived signed URL instead.
  const token = getAgentApiToken();
  const url = new URL(`${baseUrl}/reports/stream`);
  if (token) url.searchParams.set("token", token);

  const source = new EventSource(url.toString());

  const handle = (type: "report_created" | "report_updated") => (event: MessageEvent<string>) => {
    try {
      const raw = JSON.parse(event.data) as RawReportSummary;
      onEvent({ type, issue: toIssueSummary(raw) });
    } catch {
      // Malformed payload for this one event — drop it, keep the
      // subscription alive rather than tearing it down.
    }
  };

  source.addEventListener("report_created", handle("report_created"));
  source.addEventListener("report_updated", handle("report_updated"));
  if (onError) source.onerror = onError;

  return () => source.close();
}
