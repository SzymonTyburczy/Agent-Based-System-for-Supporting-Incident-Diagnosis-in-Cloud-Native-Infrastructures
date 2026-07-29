import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchIssue, fetchIssues, updateIssueStatus } from "./api";

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

function mockFetchOnce(body: unknown, init: Partial<Response> = {}) {
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
  } as Response;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response) as unknown as typeof fetch,
  );
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
  it("normalizes severity/status and drops the content field", async () => {
    mockFetchOnce([rawSummary]);

    const issues = await fetchIssues();

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
  });

  it("maps unrecognized severities to medium rather than a silent default of low", async () => {
    mockFetchOnce([{ ...rawSummary, severity: "unknown" }]);

    const [issue] = await fetchIssues();

    expect(issue.severity).toBe("medium");
  });

  it("maps warning to medium and anything but resolved to pending", async () => {
    mockFetchOnce([{ ...rawSummary, severity: "warning", status: "something-else" }]);

    const [issue] = await fetchIssues();

    expect(issue.severity).toBe("medium");
    expect(issue.status).toBe("pending");
  });

  it("passes the status filter through as a query param", async () => {
    const response = mockFetchOnce([]);
    void response;

    await fetchIssues("resolved");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8090/reports?status=resolved",
      expect.anything(),
    );
  });

  it("throws a descriptive error when VITE_AGENT_API_URL is not configured", async () => {
    vi.stubEnv("VITE_AGENT_API_URL", "");

    await expect(fetchIssues()).rejects.toThrow(/VITE_AGENT_API_URL/);
  });
});

describe("fetchIssue", () => {
  it("includes the full markdown content", async () => {
    mockFetchOnce(rawDetail);

    const issue = await fetchIssue("rep-1");

    expect(issue.content).toBe("# Checkout errors\n\nfull content");
    expect(issue.summary).toBe("Payments are timing out under load.");
  });
});

describe("updateIssueStatus", () => {
  it("sends a PATCH with the new status and returns the mapped issue", async () => {
    mockFetchOnce({ ...rawDetail, status: "resolved" });

    const issue = await updateIssueStatus("rep-1", "resolved");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8090/reports/rep-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "resolved" }),
      }),
    );
    expect(issue.status).toBe("resolved");
  });
});
