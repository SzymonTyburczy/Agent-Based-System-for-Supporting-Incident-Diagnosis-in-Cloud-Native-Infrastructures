import { describe, expect, it } from "vitest";
import { filterDocuments } from "./documentSearch";
import type { KbDocumentSummary } from "./types";

function doc(docId: string, title: string, fileName: string | null): KbDocumentSummary {
  return {
    docId,
    title,
    fileName,
    author: "Jane Doe",
    docDate: "2026-09-22",
    chunkCount: 3,
    ingestedAt: "2026-09-22T10:00:00+00:00",
  };
}

const DOCS = [
  doc("a", "Runbook: CrashLoopBackOff", "crashloop-runbook.md"),
  doc("b", "Procedura awaryjna — Łódź", "procedura_lodz.pdf"),
  doc("c", "DNS troubleshooting", null),
];

function ids(query: string): string[] {
  return filterDocuments(DOCS, query).map((d) => d.docId);
}

describe("filterDocuments", () => {
  it("keeps every document for a blank query", () => {
    expect(filterDocuments(DOCS, "")).toBe(DOCS);
    expect(ids("   ")).toEqual(["a", "b", "c"]);
  });

  it("matches the file name or the title, ignoring case", () => {
    expect(ids("RUNBOOK")).toEqual(["a"]);
    expect(ids(".pdf")).toEqual(["b"]);
    expect(ids("dns")).toEqual(["c"]);
  });

  it("ignores diacritics in both directions, Polish ł included", () => {
    expect(ids("lodz")).toEqual(["b"]);
    expect(ids("ŁÓDŹ")).toEqual(["b"]);
    expect(ids("awaryjna łodz")).toEqual(["b"]);
  });

  it("requires every word, each in either field", () => {
    // "runbook" is in both fields of "a", "md" only in its file name.
    expect(ids("runbook md")).toEqual(["a"]);
    expect(ids("runbook dns")).toEqual([]);
  });

  it("does not search the author or any other field", () => {
    expect(ids("jane")).toEqual([]);
  });

  it("searches only the title of a document without a file name", () => {
    expect(ids("troubleshooting")).toEqual(["c"]);
    expect(ids("null")).toEqual([]);
  });
});
