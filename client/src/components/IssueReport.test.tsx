import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ErrorSourcesSection,
  ProblemSection,
  RawDiagnosisSection,
  SourcesSection,
} from "./IssueReport";
import type { DocCitation } from "../lib/types";

// Rendered to static HTML: the tests run in node with no DOM, and the markup
// alone shows where the chips land and what stays text.

const CITATIONS: DocCitation[] = [
  {
    key: "KB1",
    docId: "doc-1",
    fileName: "payments.md",
    title: "Payments runbook",
    sectionPath: ["Payments runbook", "Diagnosis"],
    chunkIndex: 2,
    quote: "Payments runbook > Diagnosis\n\nCheck the connection pool first.",
  },
  {
    key: null,
    docId: "doc-2",
    fileName: "network.pdf",
    title: "Network notes",
    sectionPath: [],
    chunkIndex: null,
    quote: null,
  },
];

const citationProps = { citations: CITATIONS, onOpenCitation: () => {} };

const CHIP = /<button[^>]*aria-label="Source 1"[^>]*>1<\/button>/;

describe("citation chips in the report", () => {
  it("draws known markers in plain-text fields as chips and keeps the rest text", () => {
    const markup = renderToStaticMarkup(
      <ErrorSourcesSection
        items={["rate(payments_api_errors[5m]) [KB1] [KB7]"]}
        {...citationProps}
      />,
    );
    expect(markup).toMatch(CHIP);
    // Not Markdown: the underscores survive, and an unknown key stays as written.
    expect(markup).toContain("rate(payments_api_errors[5m]) ");
    expect(markup).toContain(" [KB7]");
  });

  it("draws markers in the Markdown problem as chips, but not inside code", () => {
    const markup = renderToStaticMarkup(
      <ProblemSection
        problem="Pool saturated [KB1]. See `[KB1]`."
        isRaw={false}
        {...citationProps}
      />,
    );
    expect(markup).toMatch(CHIP);
    expect(markup).toContain("<code>[KB1]</code>");
  });

  it("draws markers in raw text without parsing it as Markdown", () => {
    const text = "Line one [kb1]\n  - not a list";
    const markup = renderToStaticMarkup(
      <RawDiagnosisSection text={text} defaultOpen {...citationProps} />,
    );
    expect(markup).toMatch(CHIP);
    expect(markup).toContain("\n  - not a list</pre>");
  });
});

describe("SourcesSection", () => {
  it("numbers passage citations and shows a whole-document citation by file only", () => {
    const markup = renderToStaticMarkup(<SourcesSection {...citationProps} />);
    expect(markup).toContain(">[1]</span>");
    expect(markup).toContain("payments.md");
    expect(markup).toContain("Payments runbook &gt; Diagnosis");
    // The quote, without its breadcrumb, is the chip's tooltip.
    expect(markup).toContain('title="Check the connection pool first."');
    expect(markup).toContain("network.pdf");
    expect(markup).not.toContain("[2]");
  });
});
