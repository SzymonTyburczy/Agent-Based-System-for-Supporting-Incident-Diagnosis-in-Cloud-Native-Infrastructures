import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestDocument, KnowledgeBaseError } from "./knowledgeBase";
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
