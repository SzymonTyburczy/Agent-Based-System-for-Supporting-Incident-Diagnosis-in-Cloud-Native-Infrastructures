import { describe, expect, it } from "vitest";
import { findSectionHeading, locateFragment, stripBreadcrumb } from "./fragment";

describe("stripBreadcrumb", () => {
  it("removes the server's breadcrumb prefix", () => {
    expect(
      stripBreadcrumb("Runbook > Diagnosis\n\nCheck the logs.", ["Runbook", "Diagnosis"]),
    ).toBe("Check the logs.");
  });

  it("leaves a quote without that exact prefix untouched", () => {
    const cases: [string, string[]][] = [
      ["Check the logs.", ["Runbook", "Diagnosis"]],
      // Another path, or the right path without the blank line, is document text.
      ["Runbook > Other\n\nCheck the logs.", ["Runbook", "Diagnosis"]],
      ["Runbook > Diagnosis\nCheck the logs.", ["Runbook", "Diagnosis"]],
      ["\n\nCheck the logs.", []],
    ];
    for (const [quote, path] of cases) expect(stripBreadcrumb(quote, path)).toBe(quote);
  });
});

describe("locateFragment", () => {
  it("returns offsets that slice exactly the quoted text", () => {
    const markdown = "# Runbook\n\n## Diagnosis\n\nCheck the container logs.\n\n## Fix\n\nRestart.";

    const range = locateFragment(markdown, "Check the container logs.");

    expect(range).not.toBeNull();
    expect(markdown.slice(range!.start, range!.end)).toBe("Check the container logs.");
  });

  it("matches across differences in line breaks and indentation", () => {
    const markdown = "Intro.\n\n- step one\n  continues here\n- step two\n\nOutro.";

    const range = locateFragment(markdown, "  - step one continues\nhere   - step two  ");

    expect(markdown.slice(range!.start, range!.end)).toBe(
      "- step one\n  continues here\n- step two",
    );
  });

  it("finds a passage of a reconstructed document joined with its own blank lines", () => {
    const markdown = "First chunk ends here.\n\nSecond chunk starts here.";

    const range = locateFragment(markdown, "ends here.\nSecond chunk");

    expect(markdown.slice(range!.start, range!.end)).toBe("ends here.\n\nSecond chunk");
  });

  it("takes the first occurrence", () => {
    const markdown = "Restart the pod.\n\nThen, again: Restart the pod.";

    expect(locateFragment(markdown, "Restart the pod.")).toEqual({ start: 0, end: 16 });
  });

  it("falls back to the quote's opening and bounds the end by the quote's length", () => {
    const opening = "word ".repeat(50).trim(); // longer than the 200-character prefix
    // Single-spaced, so normalised and original lengths agree.
    const markdown = `Before. ${opening} and the real ending. ${"More text. ".repeat(20)}`;
    const quote = `${opening} and an ending that was edited since…`;

    const range = locateFragment(markdown, quote);

    expect(range).not.toBeNull();
    expect(range!.start).toBe(markdown.indexOf("word"));
    expect(range!.end - range!.start).toBe(quote.length);
  });

  it("does not run past the end of the document on the prefix fallback", () => {
    const opening = "x".repeat(250);
    const markdown = `${opening} tail`;

    const range = locateFragment(markdown, `${opening} ${"y".repeat(500)}`);

    expect(range).toEqual({ start: 0, end: markdown.length });
  });

  it("returns null for a short quote that is not in the document", () => {
    expect(locateFragment("# Runbook\n\nCheck the logs.", "Restart the node.")).toBeNull();
  });

  it("returns null for a long quote whose opening is not in the document either", () => {
    expect(locateFragment("# Runbook\n\nCheck the logs.", "z".repeat(300))).toBeNull();
  });

  it("returns null for a blank quote instead of matching everywhere", () => {
    expect(locateFragment("anything", "  \n\t")).toBeNull();
    expect(locateFragment("anything", "")).toBeNull();
  });
});

describe("findSectionHeading", () => {
  const runbook = [
    "# Alerts runbook",
    "",
    "## KubePodCrashLooping",
    "",
    "### Diagnosis",
    "",
    "Check the logs.",
    "",
    "## KubeNodeNotReady",
    "",
    "### Diagnosis",
    "",
    "Check the kubelet.",
  ].join("\n");

  function heading(markdown: string, path: string[]): string | null {
    const range = findSectionHeading(markdown, path);
    return range ? markdown.slice(range.start, range.end) : null;
  }

  it("prefers the heading whose whole path matches over an earlier namesake", () => {
    const range = findSectionHeading(runbook, ["Alerts runbook", "KubeNodeNotReady", "Diagnosis"]);

    expect(range!.start).toBe(runbook.lastIndexOf("### Diagnosis"));
    expect(runbook.slice(range!.start, range!.end)).toBe("### Diagnosis");
  });

  it("falls back to the first heading named like the last path element", () => {
    const range = findSectionHeading(runbook, ["Renamed runbook", "Diagnosis"]);

    expect(range!.start).toBe(runbook.indexOf("### Diagnosis"));
  });

  it("finds a deeper heading by name, though it starts no section on the server", () => {
    expect(heading("# Doc\n\n#### Rollback\n\nSteps.", ["Doc", "Rollback"])).toBe("#### Rollback");
  });

  it("ignores heading-like lines in fenced code and indented code", () => {
    const markdown = "# Doc\n\n```bash\n# Diagnosis\n```\n\n    # Diagnosis\n\n## Diagnosis\n";

    expect(findSectionHeading(markdown, ["Doc", "Diagnosis"])!.start).toBe(
      markdown.indexOf("## Diagnosis"),
    );
  });

  it("reads headings the way the server's chunker does", () => {
    // Up to three spaces of indent, a tab after the hashes, surrounding spaces trimmed.
    expect(heading("   ##\tDiagnosis  \n\ntext", ["Diagnosis"])).toBe("   ##\tDiagnosis  ");
    // No space after the hashes: not a heading.
    expect(heading("#Diagnosis\n\ntext", ["Diagnosis"])).toBeNull();
  });

  it("returns null when nothing matches or there is no path", () => {
    expect(findSectionHeading(runbook, ["Alerts runbook", "Mitigation"])).toBeNull();
    expect(findSectionHeading(runbook, [])).toBeNull();
  });

  it("gives offsets into the original text of a CRLF document", () => {
    const markdown = "# Doc\r\n\r\n## Fix\r\n\r\nRestart.";

    expect(heading(markdown, ["Doc", "Fix"])).toBe("## Fix");
  });
});
