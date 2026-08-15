import { describe, expect, it } from "vitest";
import { deriveReportSections } from "./issueView";
import type { IssueDetail } from "./types";

function detail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    id: "rep-1",
    title: "Checkout errors",
    service: "checkout",
    severity: "critical",
    status: "pending",
    createdAt: "2026-07-18T14:30:00Z",
    summary: "Payments are timing out.",
    problem: "The payment service is timing out under load.",
    errorSources: ["checkout pod logs"],
    remediations: ["Scale the payment deployment"],
    rawDiagnosis: "Report:\nThe alert is firing.",
    markdownExport: "# Checkout errors",
    ...overrides,
  };
}

describe("deriveReportSections", () => {
  it("hides the raw diagnosis when it is blank or whitespace-only", () => {
    expect(deriveReportSections(detail({ rawDiagnosis: "" })).showRawDiagnosis).toBe(false);
    expect(deriveReportSections(detail({ rawDiagnosis: "  \n\t " })).showRawDiagnosis).toBe(false);
  });

  it("detects the structuring-failure path where problem IS the raw diagnosis", () => {
    // agent_core/report.py sets problem = fallback_diagnosis when the
    // structuring call returns invalid JSON, and render_report_markdown then
    // emits the same text under ## Problem AND ## Raw diagnosis.
    const text = "Report:\nThe alert is firing.";
    const sections = deriveReportSections(
      detail({ problem: `  ${text}  `, rawDiagnosis: text.replace(/\n/g, "\r\n") }),
    );

    expect(sections.problemIsRaw).toBe(true);
    expect(sections.showRawDiagnosis).toBe(false);
  });

  it("treats a mere substring match as different content", () => {
    const sections = deriveReportSections(
      detail({ problem: "Timeouts.", rawDiagnosis: "Timeouts. And more detail." }),
    );

    expect(sections.problemIsRaw).toBe(false);
    expect(sections.showRawDiagnosis).toBe(true);
  });

  it("preserves internal structure byte-for-byte, trimming only the surround", () => {
    const body = "line one\n\n    indented\n- item\n1. first";
    const sections = deriveReportSections(detail({ problem: `\n${body}\n\n` }));

    expect(sections.problem).toBe(body);
  });

  it("opens the disclosure only when the raw dump is the only content", () => {
    const onlyRaw = deriveReportSections(
      detail({ problem: "", errorSources: [], remediations: [], rawDiagnosis: "just this" }),
    );
    expect(onlyRaw.rawDiagnosisOpen).toBe(true);

    const withStructure = deriveReportSections(
      detail({ problem: "", errorSources: ["a source"], remediations: [] }),
    );
    expect(withStructure.rawDiagnosisOpen).toBe(false);
  });

  it("is empty when all four fields are blank, even with a markdown export", () => {
    const sections = deriveReportSections(
      detail({
        problem: "",
        rawDiagnosis: "",
        errorSources: [],
        remediations: [],
        markdownExport: "# Something",
      }),
    );

    expect(sections.isEmpty).toBe(true);
  });
});
