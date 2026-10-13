import { describe, expect, it } from "vitest";
import {
  citationKeyFromHref,
  citationLabel,
  linkifyCitations,
  splitCitationTokens,
} from "./citations";
import type { DocCitation } from "./types";

function citation(overrides: Partial<DocCitation> & { docId: string }): DocCitation {
  return {
    key: null,
    fileName: `${overrides.docId}.md`,
    title: overrides.docId,
    sectionPath: [],
    chunkIndex: null,
    quote: null,
    ...overrides,
  };
}

const KB1 = citation({ key: "KB1", docId: "runbook", chunkIndex: 0, quote: "Restart the pod." });
const KB3 = citation({ key: "KB3", docId: "runbook", chunkIndex: 4, quote: "Check the logs." });
const WHOLE = citation({ docId: "dns" });
// Report order: two keyed citations, then a whole-document one.
const CITATIONS = [KB3, KB1, WHOLE];

describe("citationLabel", () => {
  it("is the 1-based position in the report's list", () => {
    expect(CITATIONS.map((c) => citationLabel(CITATIONS, c))).toEqual([1, 2, 3]);
  });

  it("matches an equal copy, not only the same object", () => {
    expect(citationLabel(CITATIONS, { ...KB1 })).toBe(2);
    expect(citationLabel(CITATIONS, { ...WHOLE })).toBe(3);
  });

  it("is 0 for a citation that is not in the list", () => {
    expect(citationLabel(CITATIONS, citation({ key: "KB9", docId: "runbook" }))).toBe(0);
  });
});

describe("splitCitationTokens", () => {
  it("returns plain text as a single segment", () => {
    expect(splitCitationTokens("No sources here.", CITATIONS)).toEqual([
      { kind: "text", text: "No sources here." },
    ]);
    expect(splitCitationTokens("", CITATIONS)).toEqual([]);
  });

  it("splits known keys into chips labelled by list position", () => {
    expect(splitCitationTokens("Restart it [KB1]. Then check [KB3][KB1]", CITATIONS)).toEqual([
      { kind: "text", text: "Restart it " },
      { kind: "cite", citation: KB1, label: 2 },
      { kind: "text", text: ". Then check " },
      { kind: "cite", citation: KB3, label: 1 },
      { kind: "cite", citation: KB1, label: 2 },
    ]);
  });

  it("accepts the variants agent-core leaves in the raw diagnosis", () => {
    const variants = ["[kb1]", "[ KB 1 ]", "(KB1)", "[KB01]", "[KB1, KB1]"];
    for (const variant of variants) {
      expect(splitCitationTokens(`a ${variant} b`, CITATIONS)).toEqual([
        { kind: "text", text: "a " },
        { kind: "cite", citation: KB1, label: 2 },
        { kind: "text", text: " b" },
      ]);
    }
  });

  it("splits a group into one chip per known key, dropping unknown ones", () => {
    expect(splitCitationTokens("x [KB3, KB9; KB1]", CITATIONS)).toEqual([
      { kind: "text", text: "x " },
      { kind: "cite", citation: KB3, label: 1 },
      { kind: "cite", citation: KB1, label: 2 },
    ]);
  });

  it("leaves unknown markers, bare keys and lookalikes as text", () => {
    for (const text of ["see [KB9]", "see KB1", "see [KB]", "see [KBX1]", "see [KB1 and more]"]) {
      expect(splitCitationTokens(text, CITATIONS)).toEqual([{ kind: "text", text }]);
    }
  });

  it("never turns a marker into a chip when the report has no keyed citations", () => {
    expect(splitCitationTokens("see [KB1]", [WHOLE])).toEqual([
      { kind: "text", text: "see [KB1]" },
    ]);
  });
});

describe("linkifyCitations", () => {
  it("rewrites known markers as numbered links", () => {
    expect(linkifyCitations("Restart it [KB1]. Check [KB3, KB1].", CITATIONS)).toBe(
      "Restart it [2](#cite-KB1). Check [1](#cite-KB3)[2](#cite-KB1).",
    );
  });

  it("leaves unknown markers as written", () => {
    expect(linkifyCitations("Restart it [KB9].", CITATIONS)).toBe("Restart it [KB9].");
  });

  it("leaves inline code spans alone, whatever their backtick count", () => {
    expect(linkifyCitations("Use `[KB1]` or ``a ` [KB1]`` but [KB1].", CITATIONS)).toBe(
      "Use `[KB1]` or ``a ` [KB1]`` but [2](#cite-KB1).",
    );
  });

  it("treats an unmatched backtick as text, within its paragraph only", () => {
    expect(linkifyCitations("A stray ` tick [KB1].\n\nNext `[KB3]` [KB3]", CITATIONS)).toBe(
      "A stray ` tick [2](#cite-KB1).\n\nNext `[KB3]` [1](#cite-KB3)",
    );
  });

  it("leaves fenced code blocks alone", () => {
    const markdown = "Before [KB1].\n\n```\necho [KB1]\n```\n\n~~~\n[KB3]\n~~~\nAfter [KB3].";

    expect(linkifyCitations(markdown, CITATIONS)).toBe(
      "Before [2](#cite-KB1).\n\n```\necho [KB1]\n```\n\n~~~\n[KB3]\n~~~\nAfter [1](#cite-KB3).",
    );
  });

  it("keeps every other byte of the document, line endings included", () => {
    const markdown = "# Title\r\n\r\n- one [KB1]\r\n  - two\r\n\r\n\ttabbed\r\n";

    expect(linkifyCitations(markdown, CITATIONS)).toBe(
      "# Title\r\n\r\n- one [2](#cite-KB1)\r\n  - two\r\n\r\n\ttabbed\r\n",
    );
  });

  it("escapes a '!' before a marker, so the chip does not turn into an image", () => {
    expect(linkifyCitations("Restart it now![KB1] Or!![KB3]", CITATIONS)).toBe(
      "Restart it now\\![2](#cite-KB1) Or!\\![1](#cite-KB3)",
    );
    // An escaped "!" is already literal text.
    expect(linkifyCitations("Now\\![KB1]", CITATIONS)).toBe("Now\\![2](#cite-KB1)");
  });

  it("leaves a marker inside another link's text alone, so that link still works", () => {
    const markdown = "See [the runbook [KB1]](https://x.example) and ![alt (KB3)](y.png) [KB3].";

    expect(linkifyCitations(markdown, CITATIONS)).toBe(
      "See [the runbook [KB1]](https://x.example) and ![alt (KB3)](y.png) [1](#cite-KB3).",
    );
  });

  it("still links a marker directly followed by a parenthesis", () => {
    expect(linkifyCitations("OOM [KB1](512 MiB limit).", CITATIONS)).toBe(
      "OOM [2](#cite-KB1)(512 MiB limit).",
    );
  });

  it("returns the text unchanged when no citation has a key", () => {
    const markdown = "Mentions [KB1] and `code`.";

    expect(linkifyCitations(markdown, [WHOLE])).toBe(markdown);
    expect(linkifyCitations(markdown, [])).toBe(markdown);
  });
});

describe("citationKeyFromHref", () => {
  it("reads the key back from a linkified marker", () => {
    expect(citationKeyFromHref("#cite-KB3")).toBe("KB3");
  });

  it("returns null for every other link", () => {
    for (const href of [undefined, "", "#cite-", "https://example.com/#cite-KB1", "#section"]) {
      expect(citationKeyFromHref(href)).toBeNull();
    }
  });
});
