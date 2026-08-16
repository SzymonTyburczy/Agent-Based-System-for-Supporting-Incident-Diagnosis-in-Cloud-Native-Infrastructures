import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPayload, convertToMarkdown, detectSourceFormat } from "./converter";

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

describe("convertToMarkdown", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CONVERTER_URL", "http://localhost:5001");
    vi.stubEnv("VITE_CONVERTER_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function mockConverter(body: unknown, ok = true, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({ ok, status, json: async () => body } as Response);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    return fetchMock;
  }

  it("posts a PDF to the service as multipart and returns its markdown", async () => {
    const fetchMock = mockConverter({ markdown: "## Runbook", pages: 1 });

    const result = await convertToMarkdown(
      new File([new Uint8Array([1, 2])], "runbook.pdf", { type: "application/pdf" }),
    );

    expect(result).toEqual({ markdown: "## Runbook", sourceFormat: "pdf", engine: "docling" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:5001/convert");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  it("sends the bearer token only when one is configured", async () => {
    const withoutToken = mockConverter({ markdown: "x".repeat(10) });
    await convertToMarkdown(new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" }));
    expect((withoutToken.mock.calls[0][1] as RequestInit).headers).toEqual({});

    vi.stubEnv("VITE_CONVERTER_TOKEN", "s3cret");
    const withToken = mockConverter({ markdown: "x".repeat(10) });
    await convertToMarkdown(new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" }));
    expect((withToken.mock.calls[0][1] as RequestInit).headers).toEqual({
      Authorization: "Bearer s3cret",
    });
  });

  it("surfaces the service's own explanation rather than a bare status code", async () => {
    // 415/422 carry a message the user can act on ("Only PDF files…",
    // "Almost no text could be extracted…").
    mockConverter({ error: "Almost no text could be extracted." }, false, 422);

    await expect(
      convertToMarkdown(new File([new Uint8Array([1])], "scan.pdf", { type: "application/pdf" })),
    ).rejects.toThrow("Almost no text could be extracted.");
  });

  it("explains an unreachable converter instead of leaking a TypeError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(
      convertToMarkdown(new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" })),
    ).rejects.toThrow(/Could not reach the document converter/);
  });

  it("names the missing setting when the converter URL is not configured", async () => {
    vi.stubEnv("VITE_CONVERTER_URL", "");

    await expect(
      convertToMarkdown(new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" })),
    ).rejects.toThrow(/VITE_CONVERTER_URL/);
  });

  it("passes markdown and text files through without calling the service", async () => {
    const fetchMock = mockConverter({ markdown: "should not be used" });

    const result = await convertToMarkdown(
      new File(["# Already markdown"], "runbook.md", { type: "text/markdown" }),
    );

    // Docling would reflow an already-valid document; the passthrough is the
    // only way it stays byte-exact.
    expect(result).toEqual({
      markdown: "# Already markdown",
      sourceFormat: "markdown",
      engine: "passthrough",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
