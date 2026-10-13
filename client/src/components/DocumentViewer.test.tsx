import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentViewer } from "./DocumentViewer";
import { documentKeys } from "../lib/documentsCache";
import type { DocCitation, KbDocument } from "../lib/types";

// Rendered to static HTML from a pre-filled cache: no DOM and no fetch, just
// which passage the viewer decides to highlight and which notes it shows.

const CONTENT = [
  "# Payments runbook",
  "",
  "## High latency",
  "",
  "### Diagnosis",
  "",
  "Check the connection pool first.",
  "",
  "### Remediation",
  "",
  "Raise max_pool_size to 40.",
].join("\n");

function kbDocument(overrides: Partial<KbDocument> = {}): KbDocument {
  return {
    docId: "doc-1",
    title: "Payments runbook",
    fileName: "payments.md",
    author: "",
    docDate: "2026-10-01",
    chunkCount: 3,
    ingestedAt: "2026-10-01T00:00:00Z",
    content: CONTENT,
    contentSource: "stored",
    ...overrides,
  };
}

function citation(overrides: Partial<DocCitation> = {}): DocCitation {
  return {
    key: "KB1",
    docId: "doc-1",
    fileName: "payments.md",
    title: "Payments runbook",
    sectionPath: ["Payments runbook", "High latency", "Diagnosis"],
    chunkIndex: 1,
    quote: null,
    ...overrides,
  };
}

function render(doc: KbDocument, cited: DocCitation | null): string {
  const client = new QueryClient();
  client.setQueryData(documentKeys.detail(doc.docId), doc);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DocumentViewer docId={doc.docId} citation={cited} nonce={0} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

/** The text of every element marked as the cited passage. */
function highlightedText(markup: string): string[] {
  return Array.from(markup.matchAll(/data-cite-highlight="">([^<]*)</g), (m) => m[1]);
}

const MISSED_NOTE = "Couldn&#x27;t find the cited passage";

describe("DocumentViewer", () => {
  it("highlights the quoted passage, breadcrumb or not", () => {
    const quote =
      "Payments runbook > High latency > Diagnosis\n\nCheck the connection   pool first.";
    const markup = render(kbDocument(), citation({ quote }));
    expect(highlightedText(markup)).toEqual(["Check the connection pool first."]);
    expect(markup).not.toContain(MISSED_NOTE);
  });

  it("falls back to the cited section's heading when the quote is gone", () => {
    const markup = render(kbDocument(), citation({ quote: "Text edited away since." }));
    expect(highlightedText(markup)).toEqual(["Diagnosis"]);
    expect(markup).not.toContain(MISSED_NOTE);
  });

  it("says so when neither the passage nor its section is found", () => {
    const cited = citation({ quote: "Text edited away since.", sectionPath: ["Elsewhere"] });
    const markup = render(kbDocument(), cited);
    expect(highlightedText(markup)).toEqual([]);
    expect(markup).toContain(MISSED_NOTE);
  });

  it("opens a whole-document citation from the top without a note", () => {
    const cited = citation({ key: null, sectionPath: [], chunkIndex: null, quote: null });
    const markup = render(kbDocument(), cited);
    expect(highlightedText(markup)).toEqual([]);
    expect(markup).not.toContain(MISSED_NOTE);
  });

  it("names the document by file name, with the title beside it", () => {
    const markup = render(kbDocument(), null);
    expect(markup).toContain('aria-label="Document: payments.md"');
    expect(markup).toContain(">Payments runbook</p>");
  });

  it("has a focusable heading for opening to move focus to", () => {
    expect(render(kbDocument(), null)).toMatch(/<h2 tabindex="-1"[^>]*>payments\.md<\/h2>/);
  });

  it("falls back to the title for a document without a file name", () => {
    const markup = render(kbDocument({ fileName: null }), null);
    expect(markup).toContain('aria-label="Document: Payments runbook"');
  });

  it("flags a document reconstructed from its chunks", () => {
    expect(render(kbDocument(), null)).not.toContain("Reconstructed from its indexed fragments");
    expect(render(kbDocument({ contentSource: "reconstructed" }), null)).toContain(
      "Reconstructed from its indexed fragments",
    );
  });
});
