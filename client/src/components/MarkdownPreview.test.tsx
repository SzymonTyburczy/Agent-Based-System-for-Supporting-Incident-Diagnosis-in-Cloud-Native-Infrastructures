import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

// Rendered to static HTML: the tests run in node with no DOM, and the markup
// alone shows which elements the component overrides produce.

const DOC = [
  "# Runbook", // 0..9
  "",
  "First paragraph.", // 11..27
  "",
  "- item one", // 29..39
  "- item two", // 40..50
  "",
  "> quoted line", // 52..65
  "",
  "Last paragraph.",
].join("\n");

function highlighted(html: string, start: number, end: number): string[] {
  const markup = renderToStaticMarkup(
    <MarkdownPreview content={html} highlight={{ start, end }} source="knowledge-base" />,
  );
  return Array.from(markup.matchAll(/<(\w+)[^>]*data-cite-highlight/g), (m) => m[1]);
}

describe("MarkdownPreview highlight", () => {
  it("marks only the block elements whose source overlaps the range", () => {
    expect(highlighted(DOC, DOC.indexOf("First"), DOC.indexOf("First") + 5)).toEqual(["p"]);
  });

  it("marks every block a range spans, nested ones included", () => {
    const start = DOC.indexOf("item two");
    const end = DOC.indexOf("quoted line") + 3;
    // The blockquote and its paragraph both overlap; CSS tints the innermost.
    expect(highlighted(DOC, start, end)).toEqual(["li", "blockquote", "p"]);
  });

  it("treats the range as half-open, like remark's offsets", () => {
    const end = DOC.indexOf("First"); // the paragraph starts exactly here
    expect(highlighted(DOC, 0, end)).toEqual(["h1"]);
  });

  describe("in a tight nested list", () => {
    const STEPS = [
      "## Steps",
      "",
      "1. Check the pods",
      "   - kubectl get pods -n payments",
      "   - kubectl describe pod X",
      "2. Restart",
    ].join("\n");

    /** Each item's opening tag attributes, keyed by the text it starts with. */
    function items(start: number, end: number): Record<string, string> {
      const markup = renderToStaticMarkup(
        <MarkdownPreview content={STEPS} highlight={{ start, end }} source="knowledge-base" />,
      );
      return Object.fromEntries(
        Array.from(markup.matchAll(/<li([^>]*)>([^<\n]*)/g), (m) => [m[2], m[1].trim()]),
      );
    }

    it("keeps the tint on an item whose own text is cited along with its sub-items", () => {
      const start = STEPS.indexOf("1.");
      const end = STEPS.indexOf("describe pod X") + "describe pod X".length;
      // `data-cite-own` exempts the outer item from the CSS that clears an
      // outer highlight in favour of the inner ones.
      expect(items(start, end)["Check the pods"]).toBe(
        'class="cite-highlight" data-cite-highlight="" data-cite-own=""',
      );
    });

    it("leaves the outer tint to clear when only sub-items are cited", () => {
      const start = STEPS.indexOf("kubectl get");
      const end = STEPS.indexOf("describe pod X") + "describe pod X".length;
      const marked = items(start, end);
      expect(marked["Check the pods"]).toBe('class="cite-highlight" data-cite-highlight=""');
      expect(marked["kubectl get pods -n payments"]).toContain("data-cite-highlight");
      expect(marked["Restart"]).toBe("");
    });
  });

  it("marks a table through its scroll wrapper", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(highlighted(table, 0, 3)).toEqual(["div"]);
  });

  it("renders no highlight without a range", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content={DOC} />);
    expect(markup).not.toContain("data-cite-highlight");
    expect(markup).not.toContain("cite-highlight");
  });
});

describe("MarkdownPreview citations and links", () => {
  const content = "Pool saturated [1](#cite-KB1). See [docs](https://example.com/x).";

  it("turns #cite links into chips and keeps other links external", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content={content} onCite={() => {}} />);
    expect(markup).toMatch(/<button[^>]*aria-label="Source 1"[^>]*>1<\/button>/);
    expect(markup).not.toContain('href="#cite-KB1"');
    expect(markup).toContain(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it("renders a chip after an escaped '!' (as linkifyCitations writes it)", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview content="Restart it now\![1](#cite-KB1)" source="agent" onCite={() => {}} />,
    );
    expect(markup).toMatch(/now!<button[^>]*aria-label="Source 1"/);
    expect(markup).not.toContain("[image:");
  });

  it("leaves #cite links as plain links without onCite", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content={content} />);
    expect(markup).not.toContain("<button");
    expect(markup).toContain('href="#cite-KB1"');
  });
});

describe("MarkdownPreview images", () => {
  const content = "![diagram](https://example.com/pixel.png)";

  it.each(["agent", "knowledge-base"] as const)("neutralizes images from %s text", (source) => {
    const markup = renderToStaticMarkup(<MarkdownPreview content={content} source={source} />);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("[image: diagram]");
  });

  it("keeps images in the user's own text", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content={content} />);
    expect(markup).toContain("<img");
  });
});
