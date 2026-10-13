import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteDocument,
  getDocument,
  ingestDocument,
  isDocumentNotFound,
  KnowledgeBaseError,
  listDocuments,
} from "./knowledgeBase";
import type { DocumentPayload } from "./types";

const PAYLOAD: DocumentPayload = {
  data: "2026-09-22",
  autor: "Jane Doe",
  tresc: "# Runbook: CrashLoopBackOff\n\n## Diagnosis\n\nCheck the container logs.",
};

function mockServer(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, json: async () => body } as Response);
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe("ingestDocument", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_RAG_API_URL", "http://localhost:8100");
    vi.stubEnv("VITE_RAG_API_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts the agreed contract as JSON to /api/documents", async () => {
    const fetchMock = mockServer({
      doc_id: "7c02bd86b9e47f75",
      title: "Runbook: CrashLoopBackOff",
      chunk_count: 3,
      already_exists: false,
    });

    const result = await ingestDocument(PAYLOAD);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8100/api/documents");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
    expect(result).toEqual({
      docId: "7c02bd86b9e47f75",
      title: "Runbook: CrashLoopBackOff",
      chunkCount: 3,
      alreadyExists: false,
    });
  });

  it("reports a repeated document as already indexed rather than as a failure", async () => {
    mockServer({
      doc_id: "7c02bd86b9e47f75",
      title: "Runbook: CrashLoopBackOff",
      chunk_count: 3,
      already_exists: true,
    });

    await expect(ingestDocument(PAYLOAD)).resolves.toMatchObject({ alreadyExists: true });
  });

  it("omits the Authorization header when no token is configured", async () => {
    const fetchMock = mockServer({ doc_id: "abc", title: "t", chunk_count: 1 });

    await ingestDocument(PAYLOAD);

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("sends the bearer token when one is configured", async () => {
    vi.stubEnv("VITE_RAG_API_TOKEN", "s3cret");
    const fetchMock = mockServer({ doc_id: "abc", title: "t", chunk_count: 1 });

    await ingestDocument(PAYLOAD);

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer s3cret");
  });

  it("surfaces the server's own explanation and status when it rejects the document", async () => {
    mockServer({ detail: "The document has no indexable content besides headings." }, false, 422);

    await expect(ingestDocument(PAYLOAD)).rejects.toMatchObject({
      message: "The document has no indexable content besides headings.",
      status: 422,
    });
  });

  it("falls back to the status code when the rejection carries no string detail", async () => {
    mockServer({ detail: [{ loc: ["body", "autor"], msg: "field required" }] }, false, 422);

    await expect(ingestDocument(PAYLOAD)).rejects.toThrow(/HTTP 422/);
  });

  it("explains an unreachable server instead of leaking the fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch,
    );

    await expect(ingestDocument(PAYLOAD)).rejects.toThrow(/Could not reach the knowledge base/);
  });

  it("rejects a response whose shape it does not recognise", async () => {
    mockServer({ unexpected: true });

    await expect(ingestDocument(PAYLOAD)).rejects.toBeInstanceOf(KnowledgeBaseError);
  });

  it("refuses to send when the base URL is not configured", async () => {
    vi.stubEnv("VITE_RAG_API_URL", "");

    await expect(ingestDocument(PAYLOAD)).rejects.toThrow(/VITE_RAG_API_URL/);
  });
});

const WIRE_SUMMARY = {
  doc_id: "7c02bd86b9e47f75",
  title: "Runbook: CrashLoopBackOff",
  file_name: "crashloop.md",
  author: "Jane Doe",
  doc_date: "2026-09-22",
  chunk_count: 3,
  ingested_at: "2026-09-22T10:00:00+00:00",
};

const SUMMARY = {
  docId: "7c02bd86b9e47f75",
  title: "Runbook: CrashLoopBackOff",
  fileName: "crashloop.md",
  author: "Jane Doe",
  docDate: "2026-09-22",
  chunkCount: 3,
  ingestedAt: "2026-09-22T10:00:00+00:00",
};

describe("document reads and deletes", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_RAG_API_URL", "http://localhost:8100");
    vi.stubEnv("VITE_RAG_API_TOKEN", "s3cret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists documents with the bearer token and maps every field", async () => {
    const fetchMock = mockServer({ documents: [WIRE_SUMMARY] });

    const documents = await listDocuments();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8100/api/documents");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: "Bearer s3cret" });
    expect(documents).toEqual([SUMMARY]);
  });

  it("lists a document ingested before file names were recorded with a null file name", async () => {
    mockServer({ documents: [{ ...WIRE_SUMMARY, file_name: undefined }] });

    const [doc] = await listDocuments();

    expect(doc.fileName).toBeNull();
  });

  it("skips a list row it cannot open instead of failing the whole list", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockServer({ documents: [{ title: "no id" }, null, WIRE_SUMMARY] });

    await expect(listDocuments()).resolves.toEqual([SUMMARY]);
  });

  it("rejects a list body that is not the documented shape", async () => {
    for (const body of [null, [], { documents: "x" }]) {
      mockServer(body);
      await expect(listDocuments()).rejects.toBeInstanceOf(KnowledgeBaseError);
    }
  });

  it("fetches one document by its URL-encoded id with its Markdown", async () => {
    const fetchMock = mockServer({
      ...WIRE_SUMMARY,
      content: "# Runbook\n\nCheck the logs.",
      content_source: "stored",
    });

    const doc = await getDocument("a/b c");

    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:8100/api/documents/a%2Fb%20c");
    expect(doc).toEqual({
      ...SUMMARY,
      content: "# Runbook\n\nCheck the logs.",
      contentSource: "stored",
    });
  });

  it("flags a document the server had to reconstruct from its chunks", async () => {
    mockServer({ ...WIRE_SUMMARY, content: "text", content_source: "reconstructed" });

    await expect(getDocument("abc")).resolves.toMatchObject({ contentSource: "reconstructed" });
  });

  it("rejects a document without its Markdown rather than showing an empty one", async () => {
    mockServer(WIRE_SUMMARY);

    await expect(getDocument("abc")).rejects.toThrow(/does not understand/);
  });

  it("turns a missing document into a 404 the caller can tell apart", async () => {
    mockServer({ detail: "Document 'abc' not found." }, false, 404);

    const error = await getDocument("abc").catch((err: unknown) => err);

    expect(error).toMatchObject({ message: "Document 'abc' not found.", status: 404 });
    expect(isDocumentNotFound(error)).toBe(true);
  });

  it("only calls a knowledge-base 404 not found", () => {
    expect(isDocumentNotFound(new KnowledgeBaseError("gone", 404))).toBe(true);
    expect(isDocumentNotFound(new KnowledgeBaseError("down", 503))).toBe(false);
    expect(isDocumentNotFound(new KnowledgeBaseError("unreachable"))).toBe(false);
    expect(isDocumentNotFound(Object.assign(new Error("x"), { status: 404 }))).toBe(false);
  });

  it("deletes with DELETE and accepts the empty 204 answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(deleteDocument("abc")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8100/api/documents/abc");
    expect(init.method).toBe("DELETE");
  });

  it("names the failed operation when a rejection carries no detail", async () => {
    mockServer(null, false, 500);
    await expect(deleteDocument("abc")).rejects.toMatchObject({
      message: "The knowledge base could not delete the document (HTTP 500).",
      status: 500,
    });

    mockServer(null, false, 502);
    await expect(listDocuments()).rejects.toThrow(/could not list its documents \(HTTP 502\)/);
  });

  it("explains an unreachable server on reads too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch,
    );

    await expect(listDocuments()).rejects.toThrow(/Could not reach the knowledge base/);
  });

  it("lets a caller's abort propagate as an abort, not as an outage", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort) as unknown as typeof fetch);

    await expect(getDocument("abc", controller.signal)).rejects.toBe(abort);
  });
});
