import { describe, expect, it } from "vitest";
import { buildPayload, detectSourceFormat } from "./converter";

describe("detectSourceFormat", () => {
  it("detects PDF files by MIME type or extension", () => {
    expect(detectSourceFormat(new File([], "report.pdf", { type: "application/pdf" }))).toBe("pdf");
    expect(detectSourceFormat(new File([], "REPORT.PDF", { type: "" }))).toBe("pdf");
  });

  it("detects markdown files", () => {
    expect(detectSourceFormat(new File([], "notes.md", { type: "" }))).toBe("markdown");
    expect(detectSourceFormat(new File([], "notes.mdx", { type: "" }))).toBe("markdown");
  });

  it("detects plain text files as text, not markdown", () => {
    expect(detectSourceFormat(new File([], "notes.txt", { type: "text/plain" }))).toBe("text");
    expect(detectSourceFormat(new File([], "log", { type: "text/plain" }))).toBe("text");
  });

  it("returns null for unsupported formats", () => {
    expect(
      detectSourceFormat(new File([], "sheet.xlsx", { type: "application/vnd.ms-excel" })),
    ).toBeNull();
    expect(detectSourceFormat(new File([], "image.png", { type: "image/png" }))).toBeNull();
  });
});

describe("buildPayload", () => {
  it("maps fields to the agreed contract (data / autor / tresc)", () => {
    const payload = buildPayload({
      markdown: "# Incident",
      author: "  Jan Kowalski  ",
      date: new Date(2026, 6, 14),
    });
    expect(payload).toEqual({
      data: "2026-07-14",
      autor: "Jan Kowalski",
      tresc: "# Incident",
    });
  });
});
