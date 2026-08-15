import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentApiError,
  fetchIssue,
  fetchIssues,
  isAbort,
  isAuthError,
  isNotFound,
  subscribeToReportEvents,
  updateIssueStatus,
  type ReportStreamEvent,
  type StreamStatus,
} from "./api";
import type { WireProblem } from "./reportWire";

const rawSummary = {
  id: "rep-1",
  generated_at: "2026-07-18T14:30:00Z",
  title: "Checkout errors",
  service: "checkout-service",
  severity: "critical",
  status: "pending",
  summary: "Payments are timing out under load.",
};

const rawDetail = {
  ...rawSummary,
  problem: "The payment service is timing out under load.",
  error_sources: ["checkout pod logs"],
  remediations: ["Scale the payment deployment"],
  raw_diagnosis: "full free-text diagnosis",
  content_md: "# Checkout errors\n\nfull content",
};

function mockFetch(body: unknown, init: Partial<Response> = {}) {
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: init.json ?? (async () => body),
  } as Response;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response) as unknown as typeof fetch);
  return response;
}

beforeEach(() => {
  vi.stubEnv("VITE_AGENT_API_URL", "http://localhost:8090");
  vi.stubEnv("VITE_AGENT_API_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchIssues", () => {
  it("normalizes the wire shape and reports no problems for a clean payload", async () => {
    mockFetch([rawSummary]);

    const { issues, problems } = await fetchIssues();

    expect(issues).toEqual([
      {
        id: "rep-1",
        title: "Checkout errors",
        service: "checkout-service",
        severity: "critical",
        status: "pending",
        createdAt: "2026-07-18T14:30:00Z",
        summary: "Payments are timing out under load.",
      },
    ]);
    expect(problems).toEqual([]);
  });

  it("throws a descriptive error when VITE_AGENT_API_URL is not configured", async () => {
    vi.stubEnv("VITE_AGENT_API_URL", "");

    // There is no client/.env.example — the tracked, empty client/.env is the template.
    await expect(fetchIssues()).rejects.toThrow(/client\/\.env/);
  });
});

describe("request", () => {
  it("wraps a non-JSON body as an AgentApiError rather than leaking a SyntaxError", async () => {
    mockFetch(undefined, {
      json: (async () => {
        throw new SyntaxError("Unexpected token '<'");
      }) as Response["json"],
    });

    await expect(fetchIssues()).rejects.toMatchObject({
      name: "AgentApiError",
      kind: "body",
    });
  });

  it("carries the HTTP status so 404 and 401 are distinguishable", async () => {
    mockFetch(null, { ok: false, status: 404, statusText: "Not Found" });
    const notFound = await fetchIssue("rep-1").catch((err: unknown) => err);
    expect(notFound).toBeInstanceOf(AgentApiError);
    expect(isNotFound(notFound)).toBe(true);

    mockFetch(null, { ok: false, status: 401, statusText: "Unauthorized" });
    const unauthorized = await fetchIssue("rep-1").catch((err: unknown) => err);
    expect(isAuthError(unauthorized)).toBe(true);
  });

  it("propagates a caller abort untouched instead of wrapping it", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(new DOMException("aborted", "AbortError")) as unknown as typeof fetch,
    );

    const err = await fetchIssues({ signal: controller.signal }).catch((e: unknown) => e);

    expect(isAbort(err)).toBe(true);
    expect(err).not.toBeInstanceOf(AgentApiError);
  });
});

describe("fetchIssue", () => {
  it("percent-encodes the route param taken from the URL bar", async () => {
    mockFetch(rawDetail);

    await fetchIssue("a/b c").catch(() => {});

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8090/reports/a%2Fb%20c",
      expect.anything(),
    );
  });

  it("maps the structured fields the UI now renders", async () => {
    mockFetch(rawDetail);

    const { issue, problems } = await fetchIssue("rep-1");

    expect(issue.problem).toBe("The payment service is timing out under load.");
    expect(issue.errorSources).toEqual(["checkout pod logs"]);
    expect(issue.remediations).toEqual(["Scale the payment deployment"]);
    expect(issue.rawDiagnosis).toBe("full free-text diagnosis");
    expect(issue.markdownExport).toBe("# Checkout errors\n\nfull content");
    expect(problems).toEqual([]);
  });

  it("rejects an unreadable detail payload instead of returning undefined fields", async () => {
    mockFetch({ title: "no id here" });

    await expect(fetchIssue("rep-1")).rejects.toMatchObject({ kind: "shape" });
    await expect(fetchIssue("rep-1")).rejects.toThrow(/unreadable/);
  });
});

describe("updateIssueStatus", () => {
  it("sends the PATCH and returns a fully mapped detail", async () => {
    mockFetch({ ...rawDetail, status: "resolved" });

    const { issue } = await updateIssueStatus("rep-1", "resolved");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8090/reports/rep-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "resolved" }),
      }),
    );
    expect(issue.status).toBe("resolved");
    // The detail page re-renders from this response alone.
    expect(issue.markdownExport).toBe("# Checkout errors\n\nfull content");
    expect(issue.errorSources).toEqual(["checkout pod logs"]);
  });
});

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static last: FakeEventSource | null = null;

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }

  addEventListener(type: string, handler: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, handler);
  }

  emit(type: string, data: string) {
    this.listeners.get(type)?.({ data } as MessageEvent<string>);
  }

  close() {
    this.closed = true;
  }
}

function subscribe() {
  const events: ReportStreamEvent[] = [];
  const statuses: StreamStatus[] = [];
  const problems: WireProblem[] = [];
  const unsubscribe = subscribeToReportEvents({
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onProblem: (problem) => problems.push(problem),
  });
  return { events, statuses, problems, unsubscribe, source: FakeEventSource.last! };
}

describe("subscribeToReportEvents", () => {
  beforeEach(() => {
    FakeEventSource.last = null;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("delivers the FULL detail payload the server publishes", () => {
    const { events, unsubscribe, source } = subscribe();

    source.emit("report_created", JSON.stringify(rawDetail));

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("report_created");
    // Proves the detail is no longer thrown away by decoding as a summary.
    expect(events[0].issue.markdownExport).toBe("# Checkout errors\n\nfull content");
    expect(events[0].issue.errorSources).toEqual(["checkout pod logs"]);
    unsubscribe();
  });

  it("reports a malformed payload and keeps the subscription alive", () => {
    const { events, problems, source } = subscribe();

    source.emit("report_created", "{not json");
    source.emit("report_updated", JSON.stringify({ title: "no id" }));
    source.emit("report_created", JSON.stringify(rawDetail));

    expect(problems.filter((problem) => problem.kind === "dropped")).toHaveLength(2);
    expect(events).toHaveLength(1);
  });

  it("lets a consumer exception propagate instead of laundering it as bad data", () => {
    const problems: WireProblem[] = [];
    subscribeToReportEvents({
      onEvent: () => {
        throw new Error("consumer bug");
      },
      onStatus: () => {},
      onProblem: (problem) => problems.push(problem),
    });

    // Regression: the old empty catch swallowed this, leaving a
    // healthy-looking subscription whose events silently no-opped.
    expect(() => FakeEventSource.last!.emit("report_created", JSON.stringify(rawDetail))).toThrow(
      /consumer bug/,
    );
    expect(problems).toEqual([]);
  });

  it("distinguishes a transient reconnect from a dead stream", () => {
    const { statuses, unsubscribe, source } = subscribe();

    expect(statuses).toEqual(["connecting"]);

    source.readyState = FakeEventSource.OPEN;
    source.onopen?.();
    expect(statuses.at(-1)).toBe("live");

    source.readyState = FakeEventSource.CONNECTING;
    source.onerror?.();
    expect(statuses.at(-1)).toBe("connecting");

    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.();
    expect(statuses.at(-1)).toBe("offline");

    unsubscribe();
    expect(source.closed).toBe(true);
  });

  it("accepts a relative base URL and appends a configured token", () => {
    vi.stubEnv("VITE_AGENT_API_URL", "/api");
    expect(() => subscribe()).not.toThrow();
    expect(FakeEventSource.last!.url).toBe("http://localhost:5173/api/reports/stream");

    vi.stubEnv("VITE_AGENT_API_URL", "http://localhost:8090");
    vi.stubEnv("VITE_AGENT_API_TOKEN", "s3cret");
    subscribe();
    expect(FakeEventSource.last!.url).toContain("token=s3cret");
  });
});
