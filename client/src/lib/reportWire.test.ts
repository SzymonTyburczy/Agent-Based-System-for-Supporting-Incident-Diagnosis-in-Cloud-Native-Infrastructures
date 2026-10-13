import { describe, expect, it, vi } from "vitest";
import { buildStreamUrl, parseReportDetail, parseReportSummaryList } from "./reportWire";

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
  citations: [
    {
      key: "KB1",
      doc_id: "7c02bd86b9e47f75",
      file_name: "payments-runbook.md",
      title: "Payments runbook",
      section_path: ["Payments runbook", "Timeouts"],
      chunk_index: 2,
      quote: "Scale the payment deployment when p99 latency exceeds 2s.",
    },
  ],
};

describe("parseReportDetail", () => {
  it("maps every wire field to the domain shape", () => {
    const result = parseReportDetail(wireDetail, "detail");

    expect(result).toEqual({
      ok: true,
      value: {
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
        citations: [
          {
            key: "KB1",
            docId: "7c02bd86b9e47f75",
            fileName: "payments-runbook.md",
            title: "Payments runbook",
            sectionPath: ["Payments runbook", "Timeouts"],
            chunkIndex: 2,
            quote: "Scale the payment deployment when p99 latency exceeds 2s.",
          },
        ],
      },
    });
  });

  it("defaults every absent narrative field rather than leaving it undefined", () => {
    const result = parseReportDetail(wireSummary, "detail");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Guards the `content.trim()` render throw that white-screened the app.
    expect(result.value.problem).toBe("");
    expect(result.value.rawDiagnosis).toBe("");
    expect(result.value.markdownExport).toBe("");
    expect(result.value.errorSources).toEqual([]);
    expect(result.value.remediations).toEqual([]);
    // A report stored before citations existed.
    expect(result.value.citations).toEqual([]);
  });

  it("keeps a whole-document citation with no key, section or quote", () => {
    const result = parseReportDetail(
      {
        ...wireDetail,
        citations: [
          {
            key: null,
            doc_id: "abc",
            file_name: "dns.md",
            title: "DNS",
            section_path: [],
            chunk_index: null,
            quote: null,
          },
        ],
      },
      "detail",
    );

    expect(result.ok && result.value.citations).toEqual([
      {
        key: null,
        docId: "abc",
        fileName: "dns.md",
        title: "DNS",
        sectionPath: [],
        chunkIndex: null,
        quote: null,
      },
    ]);
  });

  it("decodes citations tolerantly, skipping only entries it cannot open", () => {
    const result = parseReportDetail(
      {
        ...wireDetail,
        citations: [
          null,
          "KB1",
          { key: "KB1", title: "no doc id" },
          { key: "KB2", doc_id: 42 },
          { key: "KB3", doc_id: "  " },
          // Every optional field missing or wrong-typed.
          { doc_id: "doc-a", key: 7, section_path: "A > B", chunk_index: 1.5, quote: 3 },
          // No file name: falls back to the title.
          { key: "KB5", doc_id: "doc-b", title: "Runbook", chunk_index: "2" },
        ],
      },
      "detail",
    );

    expect(result.ok && result.value.citations).toEqual([
      {
        key: null,
        docId: "doc-a",
        fileName: "doc-a",
        title: "",
        sectionPath: [],
        chunkIndex: null,
        quote: null,
      },
      {
        key: "KB5",
        docId: "doc-b",
        fileName: "Runbook",
        title: "Runbook",
        sectionPath: [],
        chunkIndex: null,
        quote: null,
      },
    ]);
  });

  it("treats a non-array citations field as no citations", () => {
    for (const citations of [{}, "KB1", 42, null]) {
      const result = parseReportDetail({ ...wireDetail, citations }, "detail");
      expect(result.ok && result.value.citations).toEqual([]);
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
  });

  it("rejects a payload with no usable id, naming the source", () => {
    for (const payload of [
      null,
      [],
      "a string",
      42,
      { title: "no id" },
      { ...wireSummary, id: " " },
    ]) {
      const result = parseReportDetail(payload, "stream");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/^stream:/);
    }
  });

  it("repairs wrong-typed fields instead of throwing", () => {
    // Regression for "Cannot read properties of undefined (reading
    // 'toLowerCase')", which used to reject the whole list promise.
    const result = parseReportDetail(
      { id: "rep-2", severity: null, service: undefined, title: 123, summary: null },
      "detail",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe("medium");
    expect(result.value.service).toBe("");
    expect(result.value.title).toBe("Untitled incident report");
  });

  it("normalizes severity case-insensitively, mapping the unfamiliar to medium", () => {
    const cases: [unknown, string][] = [
      [" Critical ", "critical"],
      ["page", "critical"],
      ["warning", "medium"],
      ["info", "low"],
      // agent-core's own fallback when an alert carries no severity label.
      ["unknown", "medium"],
      ["something-new", "medium"],
    ];
    for (const [wire, expected] of cases) {
      const result = parseReportDetail({ ...wireDetail, severity: wire }, "detail");
      expect(result.ok && result.value.severity).toBe(expected);
    }
  });

  it("normalizes status, treating anything but resolved as pending", () => {
    // Regression: an exact === "resolved" made " Resolved " read as pending.
    for (const wire of ["RESOLVED", " resolved ", "resolved"]) {
      const result = parseReportDetail({ ...wireDetail, status: wire }, "detail");
      expect(result.ok && result.value.status).toBe("resolved");
    }
    for (const wire of ["something-else", undefined, null]) {
      const result = parseReportDetail({ ...wireDetail, status: wire }, "detail");
      expect(result.ok && result.value.status).toBe("pending");
    }
  });
});

describe("parseReportSummaryList", () => {
  it("skips a malformed row instead of wiping the whole list", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const issues = parseReportSummaryList([
      wireSummary,
      { generated_at: "2026-07-18T14:31:00Z" },
      { ...wireSummary, id: "rep-2" },
    ]);

    expect(issues.map((issue) => issue.id)).toEqual(["rep-1", "rep-2"]);
  });

  it("handles a non-array body instead of throwing 'body.map is not a function'", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const payload of [{}, null, "x", 42]) {
      expect(parseReportSummaryList(payload)).toEqual([]);
    }
  });
});

describe("buildStreamUrl", () => {
  const origin = "http://localhost:5173";

  it("keeps an absolute base and appends a token only when there is one", () => {
    expect(buildStreamUrl("http://localhost:8090", "", origin)).toBe(
      "http://localhost:8090/reports/stream",
    );
    expect(buildStreamUrl("http://localhost:8090", "s3cret", origin)).toBe(
      "http://localhost:8090/reports/stream?token=s3cret",
    );
  });

  it("resolves a relative base against the origin instead of throwing", () => {
    // Previously `new URL("/api/reports/stream")` threw TypeError: Invalid URL
    // synchronously inside a render effect.
    expect(buildStreamUrl("/api", "", origin)).toBe("http://localhost:5173/api/reports/stream");
  });
});
