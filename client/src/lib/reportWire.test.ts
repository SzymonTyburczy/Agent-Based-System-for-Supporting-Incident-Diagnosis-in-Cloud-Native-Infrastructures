import { describe, expect, it } from "vitest";
import {
  buildStreamUrl,
  parseReportDetail,
  parseReportSummary,
  parseReportSummaryList,
} from "./reportWire";

const wireSummary = {
  id: "rep-1",
  generated_at: "2026-07-18T14:30:00Z",
  title: "Checkout errors",
  service: "checkout-service",
  severity: "critical",
  status: "pending",
  summary: "Payments are timing out under load.",
};

const wireDetail = {
  ...wireSummary,
  problem: "The payment service is timing out under load.",
  error_sources: ["checkout pod logs"],
  remediations: ["Scale the payment deployment"],
  raw_diagnosis: "full free-text diagnosis",
  content_md: "# Checkout errors\n\nfull content",
};

describe("parseReportDetail", () => {
  it("maps every wire field to the domain shape with no warnings", () => {
    const result = parseReportDetail(wireDetail, "detail");

    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (!result.ok) return;
    expect(result.value).toEqual({
      id: "rep-1",
      createdAt: "2026-07-18T14:30:00Z",
      title: "Checkout errors",
      service: "checkout-service",
      severity: "critical",
      status: "pending",
      summary: "Payments are timing out under load.",
      problem: "The payment service is timing out under load.",
      errorSources: ["checkout pod logs"],
      remediations: ["Scale the payment deployment"],
      rawDiagnosis: "full free-text diagnosis",
      markdownExport: "# Checkout errors\n\nfull content",
    });
  });

  it("defaults every absent narrative field to a defined empty value", () => {
    const result = parseReportDetail(wireSummary, "detail");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Guards the `content.trim()` render throw that white-screened the app.
    expect(result.value.problem).toBe("");
    expect(result.value.rawDiagnosis).toBe("");
    expect(result.value.markdownExport).toBe("");
    expect(result.value.errorSources).toEqual([]);
    expect(result.value.remediations).toEqual([]);
    for (const value of Object.values(result.value)) {
      expect(value).toBeDefined();
    }
  });

  it("coerces a non-array list field and filters mixed array members", () => {
    const result = parseReportDetail(
      { ...wireDetail, error_sources: {}, remediations: ["a", 3, null, "  ", "b"] },
      "detail",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errorSources).toEqual([]);
    expect(result.value.remediations).toEqual(["a", "b"]);
    expect(result.warnings).toContain("error_sources");
    expect(result.warnings).toContain("remediations");
  });

  it("prefixes the failure reason with the source", () => {
    const result = parseReportDetail({ title: "no id" }, "stream");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^stream:/);
  });
});

describe("severity normalization", () => {
  it("is case- and whitespace-insensitive and maps through SEVERITY_MAP", () => {
    const cases: [string, string][] = [
      [" Critical ", "critical"],
      ["page", "critical"],
      ["warning", "medium"],
      ["info", "low"],
    ];
    for (const [wire, expected] of cases) {
      const result = parseReportSummary({ ...wireSummary, severity: wire });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.severity).toBe(expected);
      expect(result.warnings).not.toContain("severity");
    }
  });

  it("maps an unrecognized severity to medium — never a silent low — and warns", () => {
    const result = parseReportSummary({ ...wireSummary, severity: "unknown" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe("medium");
    expect(result.warnings).toContain("severity");
  });
});

describe("status normalization", () => {
  it("trims and lowercases before comparing", () => {
    for (const wire of ["RESOLVED", " resolved ", "resolved"]) {
      const result = parseReportSummary({ ...wireSummary, status: wire });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Regression: an exact === "resolved" made " Resolved " read as pending.
      expect(result.value.status).toBe("resolved");
    }
  });

  it("falls back to pending for anything unrecognized or missing", () => {
    expect(parseReportSummary({ ...wireSummary, status: "something-else" })).toMatchObject({
      ok: true,
      value: { status: "pending" },
    });
    const { status: _omitted, ...withoutStatus } = wireSummary;
    expect(parseReportSummary(withoutStatus)).toMatchObject({
      ok: true,
      value: { status: "pending" },
    });
  });
});

describe("parseReportSummary", () => {
  it("rejects every non-object payload", () => {
    for (const payload of [null, [], "a string", 42]) {
      const result = parseReportSummary(payload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).not.toBe("");
    }
  });

  it("rejects a record with no usable id", () => {
    for (const id of [undefined, "", "   ", 42]) {
      expect(parseReportSummary({ ...wireSummary, id })).toMatchObject({ ok: false });
    }
  });

  it("repairs wrong-typed fields instead of throwing, and names each repair", () => {
    // Regression for "Cannot read properties of undefined (reading
    // 'toLowerCase')", which used to reject the whole list promise.
    const result = parseReportSummary({
      id: "rep-2",
      severity: null,
      service: undefined,
      title: 123,
      summary: null,
      generated_at: "2026-07-18T14:30:00Z",
      status: "pending",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe("medium");
    expect(result.value.service).toBe("");
    expect(result.value.title).toBe("Untitled incident report");
    expect(result.value.summary).toBe("");
    expect(result.warnings).toEqual(
      expect.arrayContaining(["severity", "title", "service", "summary"]),
    );
  });
});

describe("parseReportSummaryList", () => {
  it("skips a malformed row instead of wiping the whole list", () => {
    const { issues, problems } = parseReportSummaryList([
      wireSummary,
      { generated_at: "2026-07-18T14:31:00Z" },
      { ...wireSummary, id: "rep-2" },
    ]);

    expect(issues.map((issue) => issue.id)).toEqual(["rep-1", "rep-2"]);
    expect(problems.filter((problem) => problem.kind === "dropped")).toHaveLength(1);
  });

  it("handles a non-array body instead of throwing 'body.map is not a function'", () => {
    for (const payload of [{}, null, "x", 42]) {
      const { issues, problems } = parseReportSummaryList(payload);
      expect(issues).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ kind: "dropped", source: "list" });
    }
  });
});

describe("buildStreamUrl", () => {
  const origin = "http://localhost:5173";

  it("keeps an absolute base URL", () => {
    expect(buildStreamUrl("http://localhost:8090", "", origin)).toBe(
      "http://localhost:8090/reports/stream",
    );
  });

  it("resolves a relative base against the origin instead of throwing", () => {
    // Previously `new URL("/api/reports/stream")` threw TypeError: Invalid URL
    // synchronously inside a render effect.
    expect(buildStreamUrl("/api", "", origin)).toBe("http://localhost:5173/api/reports/stream");
  });

  it("appends the token as a query param only when there is one", () => {
    expect(buildStreamUrl("http://localhost:8090", "s3cret", origin)).toBe(
      "http://localhost:8090/reports/stream?token=s3cret",
    );
    expect(buildStreamUrl("http://localhost:8090", "", origin)).not.toContain("token");
  });
});
