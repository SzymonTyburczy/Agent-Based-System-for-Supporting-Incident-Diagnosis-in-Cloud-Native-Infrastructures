import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentApiError,
  fetchIssue,
  fetchIssues,
  isNotFound,
  subscribeToReportEvents,
  updateIssueStatus,
  type StreamStatus,
} from "./api";
import type { IssueDetail } from "./types";

const rawDetail = {
  id: "rep-1",
  generated_at: "2026-07-18T14:30:00Z",
  title: "Checkout errors",
  service: "checkout-service",
  severity: "critical",
  status: "pending",
  summary: "Payments are timing out under load.",
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
}

beforeEach(() => {
  vi.stubEnv("VITE_AGENT_API_URL", "http://localhost:8090");
  vi.stubEnv("VITE_AGENT_API_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("request", () => {
  it("names client/.env when the base URL is not configured", async () => {
    vi.stubEnv("VITE_AGENT_API_URL", "");

    // There is no client/.env.example — the tracked, empty client/.env is the template.
    await expect(fetchIssues()).rejects.toThrow(/client\/\.env/);
  });

  it("wraps a non-JSON body rather than leaking a SyntaxError into the UI", async () => {
    mockFetch(undefined, {
      json: (async () => {
        throw new SyntaxError("Unexpected token '<'");
      }) as Response["json"],
    });

    await expect(fetchIssues()).rejects.toThrow(/isn't valid JSON/);
  });

  it("carries the HTTP status, so a 404 is distinguishable from a transport failure", async () => {
    mockFetch(null, { ok: false, status: 404, statusText: "Not Found" });

    const err = await fetchIssue("rep-1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentApiError);
    expect(isNotFound(err)).toBe(true);
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

    const err = await fetchIssues(controller.signal).catch((e: unknown) => e);

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

  it("rejects an unreadable payload instead of returning undefined fields", async () => {
    mockFetch({ title: "no id here" });

    await expect(fetchIssue("rep-1")).rejects.toThrow(/unreadable/);
  });
});

describe("updateIssueStatus", () => {
  it("sends the PATCH and returns a fully mapped detail", async () => {
    mockFetch({ ...rawDetail, status: "resolved" });

    const issue = await updateIssueStatus("rep-1", "resolved");

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
  const reports: IssueDetail[] = [];
  const statuses: StreamStatus[] = [];
  const unsubscribe = subscribeToReportEvents({
    onReport: (issue) => reports.push(issue),
    onStatus: (status) => statuses.push(status),
  });
  return { reports, statuses, unsubscribe, source: FakeEventSource.last! };
}

describe("subscribeToReportEvents", () => {
  beforeEach(() => {
    FakeEventSource.last = null;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("delivers the FULL detail payload the server publishes", () => {
    const { reports, source } = subscribe();

    source.emit("report_created", JSON.stringify(rawDetail));

    // Proves the detail is no longer thrown away by decoding it as a summary.
    expect(reports).toHaveLength(1);
    expect(reports[0].markdownExport).toBe("# Checkout errors\n\nfull content");
    expect(reports[0].errorSources).toEqual(["checkout pod logs"]);
  });

  it("drops a malformed payload and keeps the subscription alive", () => {
    const { reports, source } = subscribe();

    source.emit("report_created", "{not json");
    source.emit("report_updated", JSON.stringify({ title: "no id" }));
    source.emit("report_created", JSON.stringify(rawDetail));

    expect(reports).toHaveLength(1);
  });

  it("lets a consumer exception propagate instead of laundering it as bad data", () => {
    subscribeToReportEvents({
      onReport: () => {
        throw new Error("consumer bug");
      },
      onStatus: () => {},
    });

    // Regression: the old empty catch swallowed this, leaving a
    // healthy-looking subscription whose events silently no-opped.
    expect(() => FakeEventSource.last!.emit("report_created", JSON.stringify(rawDetail))).toThrow(
      /consumer bug/,
    );
  });

  it("distinguishes a transient reconnect from a dead stream", () => {
    const { statuses, unsubscribe, source } = subscribe();

    expect(statuses).toEqual(["connecting"]);

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

  it("accepts a relative base URL and carries a configured token", () => {
    vi.stubEnv("VITE_AGENT_API_URL", "/api");
    expect(() => subscribe()).not.toThrow();
    expect(FakeEventSource.last!.url).toBe("http://localhost:5173/api/reports/stream");

    vi.stubEnv("VITE_AGENT_API_URL", "http://localhost:8090");
    vi.stubEnv("VITE_AGENT_API_TOKEN", "s3cret");
    subscribe();
    expect(FakeEventSource.last!.url).toContain("token=s3cret");
  });
});
