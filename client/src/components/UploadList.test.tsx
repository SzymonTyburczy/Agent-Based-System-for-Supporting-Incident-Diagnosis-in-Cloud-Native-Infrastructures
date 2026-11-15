import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UploadList } from "./UploadList";
import type { UploadItem } from "../lib/uploadQueue";

// Rendered to static HTML: the tests run in node with no DOM, so they pin which
// status and which actions each row shows, not the clicks.

function item(overrides: Partial<UploadItem> & Pick<UploadItem, "id" | "stage">): UploadItem {
  return {
    fileName: `${overrides.id}.pdf`,
    sourceFormat: "pdf",
    engine: null,
    markdown: "",
    error: "",
    failedAt: null,
    result: null,
    ...overrides,
  };
}

const noop = () => {};

function render(items: UploadItem[], authorMissing = false): string {
  return renderToStaticMarkup(
    <UploadList
      items={items}
      selectedId={null}
      authorMissing={authorMissing}
      onSelect={noop}
      onApprove={noop}
      onApproveAll={noop}
      onRetry={noop}
      onRemove={noop}
      onClearFinished={noop}
    />,
  );
}

describe("UploadList", () => {
  it("offers Approve only on a converted PDF", () => {
    const html = render([
      item({ id: "ready", stage: "ready", markdown: "# A" }),
      item({ id: "converting", stage: "converting" }),
    ]);
    expect(html.match(/> Approve</g)).toHaveLength(1);
    expect(html).toContain("Converted — review and approve");
    expect(html).toContain("Converting to Markdown (Docling)…");
  });

  it("labels the remove button by what it does to the file", () => {
    const html = render([
      item({ id: "sending", stage: "sending", markdown: "# A" }),
      item({
        id: "done",
        stage: "done",
        result: { docId: "d", title: "A", chunkCount: 1, alreadyExists: false },
      }),
    ]);
    expect(html).toContain('aria-label="Cancel: sending.pdf"');
    expect(html).toContain(
      'aria-label="Remove from the list (the document stays in the knowledge base): done.pdf"',
    );
    expect(html).toContain("Added to the knowledge base (1 fragment)");
    expect(html).toContain("Clear finished");
  });

  it("shows the error and a retry on a failed file", () => {
    const html = render([
      item({ id: "bad", stage: "error", failedAt: "send", error: "The knowledge base is down." }),
    ]);
    expect(html).toContain("The knowledge base is down.");
    expect(html).toContain('aria-label="Retry bad.pdf"');
  });

  it("says why an approved document is not being sent without an author", () => {
    const approved = [item({ id: "a", stage: "approved", markdown: "# A" })];
    expect(render(approved, true)).toContain("Waiting for an author");
    expect(render(approved, false)).toContain("Waiting to be sent");
  });

  it("offers Approve all only when more than one document is ready", () => {
    const one = [item({ id: "a", stage: "ready", markdown: "# A" })];
    const two = [...one, item({ id: "b", stage: "ready", markdown: "# B" })];
    expect(render(one)).not.toContain("Approve all");
    expect(render(two)).toContain("Approve all (2)");
  });
});
