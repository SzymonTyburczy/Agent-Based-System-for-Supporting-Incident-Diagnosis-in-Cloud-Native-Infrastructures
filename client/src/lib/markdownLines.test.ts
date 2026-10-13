import { describe, expect, it } from "vitest";
import { markdownLines } from "./markdownLines";

function fenced(markdown: string): boolean[] {
  return markdownLines(markdown).map((line) => line.inFence);
}

describe("markdownLines", () => {
  it("reports each line's offset in the source across every line ending", () => {
    const source = "a\r\nbb\rccc\n\nd";

    const lines = markdownLines(source);

    expect(lines.map((line) => line.text)).toEqual(["a", "bb", "ccc", "", "d"]);
    for (const line of lines) {
      expect(source.slice(line.start, line.start + line.text.length)).toBe(line.text);
    }
  });

  it("marks a fenced block, both fence lines included", () => {
    expect(fenced("text\n```yaml\n# not a heading\n```\nafter")).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it("closes a fence only with the same character, at least as long", () => {
    expect(fenced("````\n```\n~~~~\n`````\nafter")).toEqual([true, true, true, true, false]);
  });

  it("does not take inline code alone on a line for a fence", () => {
    // Taken for a fence, it would swallow the rest of the document.
    expect(fenced("```kubectl get pods```\n# Heading")).toEqual([false, false]);
  });

  it("runs an unclosed fence to the end of the text", () => {
    expect(fenced("intro\n~~~\ncode\nmore")).toEqual([false, true, true, true]);
  });

  it("recognises a fence indented inside a list item, as the server does", () => {
    expect(fenced("1. Run:\n\n    ```\n    kubectl get pods\n    ```")).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });
});
