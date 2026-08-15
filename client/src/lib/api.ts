import { getAgentApiToken, getAgentApiUrl } from "./settings";
import {
  buildStreamUrl,
  parseReportDetail,
  parseReportSummaryList,
  type WireProblem,
} from "./reportWire";
import type { IssueDetail, IssueStatus, IssueSummary } from "./types";

export type AgentErrorKind = "config" | "network" | "http" | "body" | "shape";

export class AgentApiError extends Error {
  readonly kind: AgentErrorKind;
  /** HTTP status when the agent answered, null when it never did. */
  readonly status: number | null;

  // Written out rather than declared as constructor parameter properties:
  // tsconfig.app.json sets `erasableSyntaxOnly`.
  constructor(kind: AgentErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "AgentApiError";
    this.kind = kind;
    this.status = status;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof AgentApiError && err.status === 404;
}

/** A wrong `VITE_AGENT_API_TOKEN` is likelier than a network fault on a local panel. */
export function isAuthError(err: unknown): boolean {
  return err instanceof AgentApiError && (err.status === 401 || err.status === 403);
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export function describeAgentError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** A hung agent otherwise spins the page forever and Retry cannot help. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function authHeaders(): HeadersInit {
  const token = getAgentApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Returns `unknown` on purpose. The old `request<T>` ended in
 * `(await response.json()) as T` — a compile-time lie that let malformed wire
 * data reach the UI as if it had been validated. With `unknown`, TypeScript
 * itself forces every caller through `reportWire`'s parsers.
 */
async function request(
  path: string,
  options?: RequestOptions & { init?: RequestInit },
): Promise<unknown> {
  const baseUrl = getAgentApiUrl();
  if (!baseUrl) {
    throw new AgentApiError(
      "config",
      "VITE_AGENT_API_URL is not set — point it at agent-core's webhook_server (set it in client/.env).",
    );
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options?.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options?.init,
      signal,
      headers: { ...authHeaders(), ...options?.init?.headers },
    });
  } catch (err) {
    // The caller cancelled (effect cleanup, navigation) — propagate untouched
    // so it can be recognized by `isAbort` and ignored rather than rendered.
    if (options?.signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new AgentApiError(
        "network",
        `The diagnostic agent at ${baseUrl} did not respond within ${timeoutMs / 1000}s.`,
      );
    }
    throw new AgentApiError("network", `Could not reach the diagnostic agent at ${baseUrl}.`);
  }

  if (!response.ok) {
    // The status is a field, not just prose: it is what lets a 404 render
    // "not found", a 401 point at the token, and a 500 offer a retry.
    throw new AgentApiError(
      "http",
      `Agent API request failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }

  try {
    return await response.json();
  } catch {
    // A proxy or SPA fallback serving HTML used to surface as a raw
    // "SyntaxError: Unexpected token '<'" under the heading "Couldn't reach
    // the diagnostic agent", which was simply untrue — it answered.
    throw new AgentApiError(
      "body",
      "The diagnostic agent returned a response that isn't valid JSON.",
      response.status,
    );
  }
}

export interface FetchIssuesResult {
  issues: IssueSummary[];
  problems: WireProblem[];
}

export interface FetchIssueResult {
  issue: IssueDetail;
  problems: WireProblem[];
}

export async function fetchIssues(options?: RequestOptions): Promise<FetchIssuesResult> {
  const body = await request("/reports", options);
  return parseReportSummaryList(body);
}

async function requestDetail(
  path: string,
  id: string,
  options?: RequestOptions & { init?: RequestInit },
): Promise<FetchIssueResult> {
  const body = await request(path, options);
  const result = parseReportDetail(body, "detail");
  if (!result.ok) {
    throw new AgentApiError(
      "shape",
      `The diagnostic agent returned an unreadable report for ${id}: ${result.reason}`,
    );
  }
  return {
    issue: result.value,
    problems: result.warnings.map((reason) => ({
      source: "detail" as const,
      kind: "repaired" as const,
      id: result.value.id,
      reason: `defaulted \`${reason}\``,
    })),
  };
}

export function fetchIssue(id: string, options?: RequestOptions): Promise<FetchIssueResult> {
  // `id` comes straight from the URL bar via useParams.
  return requestDetail(`/reports/${encodeURIComponent(id)}`, id, options);
}

export function updateIssueStatus(
  id: string,
  status: IssueStatus,
  options?: RequestOptions,
): Promise<FetchIssueResult> {
  return requestDetail(`/reports/${encodeURIComponent(id)}`, id, {
    ...options,
    init: {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
  });
}

export type StreamStatus = "connecting" | "live" | "offline";

export interface ReportStreamEvent {
  kind: "report_created" | "report_updated";
  /** FULL detail — webhook_server.py publishes `record.to_dict()` on both events. */
  issue: IssueDetail;
}

export interface ReportStreamHandlers {
  onEvent: (event: ReportStreamEvent) => void;
  onStatus: (status: StreamStatus) => void;
  onProblem: (problem: WireProblem) => void;
}

/**
 * Subscribes to agent-core's SSE stream (`GET /reports/stream`) for live
 * updates on top of the initial `fetchIssues()` load. Returns an unsubscribe
 * function; call it on unmount.
 *
 * Connection problems are reported through `onStatus` rather than thrown —
 * this runs detached from any particular render, and the browser's
 * EventSource retries on its own, so a transient drop must not read as fatal.
 */
export function subscribeToReportEvents(handlers: ReportStreamHandlers): () => void {
  const baseUrl = getAgentApiUrl();
  if (!baseUrl) {
    handlers.onStatus("offline");
    handlers.onProblem({
      source: "stream",
      kind: "dropped",
      id: null,
      reason: "VITE_AGENT_API_URL is not set.",
    });
    return () => {};
  }

  let url: string;
  try {
    url = buildStreamUrl(baseUrl, getAgentApiToken(), window.location.origin);
  } catch {
    handlers.onStatus("offline");
    handlers.onProblem({
      source: "stream",
      kind: "dropped",
      id: null,
      reason: `Could not build a stream URL from VITE_AGENT_API_URL="${baseUrl}".`,
    });
    return () => {};
  }

  handlers.onStatus("connecting");
  const source = new EventSource(url);

  const handle = (kind: ReportStreamEvent["kind"]) => (event: MessageEvent<string>) => {
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      console.warn("[idar/wire] dropped %s: payload was not valid JSON", kind, event.data);
      handlers.onProblem({
        source: "stream",
        kind: "dropped",
        id: null,
        reason: `${kind}: payload was not valid JSON`,
      });
      return;
    }

    const result = parseReportDetail(payload, "stream");
    if (!result.ok) {
      console.warn("[idar/wire] dropped %s: %s", kind, result.reason, payload);
      handlers.onProblem({
        source: "stream",
        kind: "dropped",
        id: null,
        reason: `${kind}: ${result.reason}`,
      });
      return;
    }

    for (const reason of result.warnings) {
      handlers.onProblem({
        source: "stream",
        kind: "repaired",
        id: result.value.id,
        reason: `defaulted \`${reason}\``,
      });
    }

    // DELIBERATELY outside the try above: an exception thrown by the consumer
    // is the consumer's bug, not a malformed payload. The previous single
    // try with an empty catch swallowed both identically, leaving a
    // healthy-looking subscription that silently no-opped forever.
    handlers.onEvent({ kind, issue: result.value });
  };

  source.addEventListener("report_created", handle("report_created"));
  source.addEventListener("report_updated", handle("report_updated"));
  source.onopen = () => handlers.onStatus("live");
  // Branch on readyState: EventSource fires `error` on every ordinary
  // reconnect too, and alarming on those would make a healthy stream look dead.
  source.onerror = () =>
    handlers.onStatus(source.readyState === EventSource.CLOSED ? "offline" : "connecting");

  return () => source.close();
}
