import { getAgentApiToken, getAgentApiUrl } from "./settings";
import { buildStreamUrl, parseReportDetail, parseReportSummaryList } from "./reportWire";
import type { IssueDetail, IssueStatus, IssueSummary } from "./types";

export class AgentApiError extends Error {
  /** HTTP status when the agent answered, null when it never did. */
  readonly status: number | null;

  // Written out rather than a constructor parameter property: tsconfig sets
  // `erasableSyntaxOnly`.
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof AgentApiError && err.status === 404;
}

export function describeAgentError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_TIMEOUT_MS = 20_000;

function authHeaders(): HeadersInit {
  const token = getAgentApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Returns `unknown` on purpose: with a generic, the body ended in
 * `(await response.json()) as T`, a compile-time lie that let unvalidated wire
 * data reach the UI. Now TypeScript forces every caller through `reportWire`.
 */
async function request(path: string, signal?: AbortSignal, init?: RequestInit): Promise<unknown> {
  const baseUrl = getAgentApiUrl();
  if (!baseUrl) {
    throw new AgentApiError(
      "VITE_AGENT_API_URL is not set — point it at agent-core's webhook_server (set it in client/.env).",
    );
  }

  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { ...authHeaders(), ...init?.headers },
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new AgentApiError(`The diagnostic agent at ${baseUrl} did not respond in time.`);
    }
    throw new AgentApiError(`Could not reach the diagnostic agent at ${baseUrl}.`);
  }

  if (!response.ok) {
    // The status is a field, not just prose: it is what lets a 404 render
    // "not found" instead of a transport error.
    throw new AgentApiError(
      `Agent API request failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }

  try {
    return await response.json();
  } catch {
    // A proxy or SPA fallback serving HTML used to surface as a raw
    // "Unexpected token '<'" under "Couldn't reach the diagnostic agent".
    throw new AgentApiError(
      "The diagnostic agent returned a response that isn't valid JSON.",
      response.status,
    );
  }
}

export async function fetchIssues(signal?: AbortSignal): Promise<IssueSummary[]> {
  return parseReportSummaryList(await request("/reports", signal));
}

async function requestDetail(
  id: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<IssueDetail> {
  // `id` comes straight from the URL bar via useParams.
  const body = await request(`/reports/${encodeURIComponent(id)}`, signal, init);
  const result = parseReportDetail(body, "detail");
  if (!result.ok) {
    throw new AgentApiError(`The agent returned an unreadable report for ${id}: ${result.reason}`);
  }
  return result.value;
}

export function fetchIssue(id: string, signal?: AbortSignal): Promise<IssueDetail> {
  return requestDetail(id, signal);
}

export function updateIssueStatus(id: string, status: IssueStatus): Promise<IssueDetail> {
  return requestDetail(id, undefined, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

export type StreamStatus = "connecting" | "live" | "offline";

export interface ReportStreamHandlers {
  /** Receives the FULL detail — webhook_server publishes `record.to_dict()`
   * on both `report_created` and `report_updated`. */
  onReport: (issue: IssueDetail) => void;
  onStatus: (status: StreamStatus) => void;
}

/**
 * Subscribes to agent-core's SSE stream. Returns an unsubscribe function.
 *
 * Connection problems are reported through `onStatus` rather than thrown:
 * this runs detached from any render, and EventSource retries on its own, so
 * a transient drop must not read as fatal.
 */
export function subscribeToReportEvents(handlers: ReportStreamHandlers): () => void {
  const baseUrl = getAgentApiUrl();
  if (!baseUrl) {
    handlers.onStatus("offline");
    return () => {};
  }

  let url: string;
  try {
    url = buildStreamUrl(baseUrl, getAgentApiToken(), window.location.origin);
  } catch {
    console.warn("[idar/wire] could not build a stream URL from", baseUrl);
    handlers.onStatus("offline");
    return () => {};
  }

  handlers.onStatus("connecting");
  const source = new EventSource(url);

  const handle = (kind: string) => (event: MessageEvent<string>) => {
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      console.warn("[idar/wire] dropped %s: payload was not valid JSON", kind, event.data);
      return;
    }

    const result = parseReportDetail(payload, "stream");
    if (!result.ok) {
      console.warn("[idar/wire] dropped %s: %s", kind, result.reason, payload);
      return;
    }

    // DELIBERATELY outside the try above: an exception thrown by the consumer
    // is the consumer's bug, not a malformed payload. One try with an empty
    // catch swallowed both identically, leaving a healthy-looking
    // subscription that silently no-opped.
    handlers.onReport(result.value);
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
