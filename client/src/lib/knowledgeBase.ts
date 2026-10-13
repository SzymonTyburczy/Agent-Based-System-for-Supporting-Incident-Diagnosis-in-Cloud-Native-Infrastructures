import { getRagApiToken, getRagApiUrl } from "./settings";
import type { DocumentPayload, KbDocument, KbDocumentSummary } from "./types";

export class KnowledgeBaseError extends Error {
  /** HTTP status when the server answered, null when it never did. */
  readonly status: number | null;

  // Written out rather than a constructor parameter property: tsconfig sets
  // `erasableSyntaxOnly`.
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "KnowledgeBaseError";
    this.status = status;
  }
}

/** The server's "no such document" answer — an outcome to show, not a failure to retry. */
export function isDocumentNotFound(err: unknown): boolean {
  return err instanceof KnowledgeBaseError && err.status === 404;
}

export interface IngestResult {
  docId: string;
  title: string;
  chunkCount: number;
  /**
   * The server recognised identical content and indexed nothing new. Document
   * ids are a hash of `tresc`, so re-sending the same document is a no-op
   * rather than a duplicate — worth telling the user apart from a fresh ingest.
   */
  alreadyExists: boolean;
}

// Ingest embeds every chunk of the document; on the 8B model a long runbook
// takes minutes. This is a compute budget, not a network timeout.
const INGEST_TIMEOUT_MS = 180_000;
// Listing, reading and deleting touch no model, so a slow answer means a stuck server.
const DEFAULT_TIMEOUT_MS = 20_000;

const UNREADABLE_RESPONSE =
  "The knowledge base returned a response this panel does not understand.";

/** FastAPI puts its own explanation in `detail` — a string for the errors the
 * server raises itself, a list of field errors when the schema rejects the
 * body. Only the string form is worth showing verbatim. */
function serverDetail(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  /** Already-serialised JSON; its presence is what sets the Content-Type. */
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
  /** The message for a rejection that carries no string `detail`. */
  failureMessage: (status: number) => string;
}

/**
 * The one transport to the RAG server: base URL, token, timeout and error
 * mapping live here, so every call fails with the same vocabulary. Resolves
 * with the parsed JSON body of a 2xx answer — null when it has none (a 204).
 */
async function request(
  path: string,
  options: RequestOptions,
): Promise<{ status: number; body: unknown }> {
  const baseUrl = getRagApiUrl();
  if (!baseUrl) {
    throw new KnowledgeBaseError(
      "VITE_RAG_API_URL is not set — point it at the RAG server (see server/README.md).",
    );
  }

  const token = getRagApiToken();
  const { signal } = options;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      body: options.body,
      headers: {
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new KnowledgeBaseError(
        options.timeoutMessage ?? `The knowledge base at ${baseUrl} did not respond in time.`,
      );
    }
    throw new KnowledgeBaseError(
      `Could not reach the knowledge base at ${baseUrl}. Is it running?`,
    );
  }

  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    // The server explains its own rejections — a document with nothing but
    // headings, a missing token, an unknown id — so its message beats a bare
    // status code.
    throw new KnowledgeBaseError(
      serverDetail(body) ?? options.failureMessage(response.status),
      response.status,
    );
  }
  return { status: response.status, body };
}

/**
 * Sends one prepared document to the RAG knowledge base
 * (`server/`, see its README). The payload is the agreed contract built by
 * `buildPayload`; this module never reshapes it.
 */
export async function ingestDocument(
  payload: DocumentPayload,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const { status, body } = await request("/api/documents", {
    method: "POST",
    body: JSON.stringify(payload),
    signal,
    timeoutMs: INGEST_TIMEOUT_MS,
    timeoutMessage: "The knowledge base did not finish indexing in time. Try a shorter document.",
    failureMessage: (code) => `The knowledge base rejected the document (HTTP ${code}).`,
  });

  const wire = body as {
    doc_id?: unknown;
    title?: unknown;
    chunk_count?: unknown;
    already_exists?: unknown;
  } | null;

  if (typeof wire?.doc_id !== "string" || typeof wire.chunk_count !== "number") {
    throw new KnowledgeBaseError(UNREADABLE_RESPONSE, status);
  }

  return {
    docId: wire.doc_id,
    title: typeof wire.title === "string" ? wire.title : "",
    chunkCount: wire.chunk_count,
    alreadyExists: wire.already_exists === true,
  };
}

/** Null without a usable `doc_id`: such a row could be neither opened nor deleted. */
function decodeSummary(input: unknown): KbDocumentSummary | null {
  if (!isRecord(input) || typeof input.doc_id !== "string" || !input.doc_id) return null;
  return {
    docId: input.doc_id,
    title: stringField(input.title),
    // Absent on documents ingested before file names were recorded.
    fileName: stringField(input.file_name).trim() || null,
    author: stringField(input.author),
    docDate: stringField(input.doc_date),
    chunkCount: typeof input.chunk_count === "number" ? input.chunk_count : 0,
    ingestedAt: stringField(input.ingested_at),
  };
}

/**
 * Every document in the knowledge base, newest first (the server's order) —
 * metadata only, the text is fetched per document by `getDocument`. A
 * malformed row is skipped rather than failing the whole list.
 */
export async function listDocuments(signal?: AbortSignal): Promise<KbDocumentSummary[]> {
  const { status, body } = await request("/api/documents", {
    signal,
    failureMessage: (code) => `The knowledge base could not list its documents (HTTP ${code}).`,
  });

  const rows = isRecord(body) ? body.documents : undefined;
  if (!Array.isArray(rows)) throw new KnowledgeBaseError(UNREADABLE_RESPONSE, status);

  const documents: KbDocumentSummary[] = [];
  for (const row of rows) {
    const summary = decodeSummary(row);
    if (summary) documents.push(summary);
    else console.warn("[idar/wire] skipped a knowledge-base document:", row);
  }
  return documents;
}

/**
 * One document with its full Markdown. An unknown id rejects with a
 * `KnowledgeBaseError` whose `status` is 404 (see `isDocumentNotFound`).
 */
export async function getDocument(docId: string, signal?: AbortSignal): Promise<KbDocument> {
  // `docId` can come straight from the URL bar (`?doc=`).
  const { status, body } = await request(`/api/documents/${encodeURIComponent(docId)}`, {
    signal,
    failureMessage: (code) => `The knowledge base could not load the document (HTTP ${code}).`,
  });

  const summary = decodeSummary(body);
  if (!summary || !isRecord(body) || typeof body.content !== "string") {
    throw new KnowledgeBaseError(UNREADABLE_RESPONSE, status);
  }

  return {
    ...summary,
    content: body.content,
    contentSource: body.content_source === "reconstructed" ? "reconstructed" : "stored",
  };
}

/**
 * Removes a document and all its chunks. An unknown id rejects with
 * `status: 404`; whether "already gone" counts as done is the caller's call.
 */
export async function deleteDocument(docId: string, signal?: AbortSignal): Promise<void> {
  await request(`/api/documents/${encodeURIComponent(docId)}`, {
    method: "DELETE",
    signal,
    failureMessage: (code) => `The knowledge base could not delete the document (HTTP ${code}).`,
  });
}
