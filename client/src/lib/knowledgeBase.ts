import { getRagApiToken, getRagApiUrl } from "./settings";
import type { DocumentPayload } from "./types";

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

/** FastAPI puts its own explanation in `detail` — a string for the errors the
 * server raises itself, a list of field errors when the schema rejects the
 * body. Only the string form is worth showing verbatim. */
function serverDetail(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : null;
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
  const baseUrl = getRagApiUrl();
  if (!baseUrl) {
    throw new KnowledgeBaseError(
      "VITE_RAG_API_URL is not set — point it at the RAG server (see server/README.md).",
    );
  }

  const token = getRagApiToken();
  const timeout = AbortSignal.timeout(INGEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/documents`, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new KnowledgeBaseError(
        "The knowledge base did not finish indexing in time. Try a shorter document.",
      );
    }
    throw new KnowledgeBaseError(
      `Could not reach the knowledge base at ${baseUrl}. Is it running?`,
    );
  }

  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    // The server explains its own rejections — a document with nothing but
    // headings, a missing token — so its message beats a bare status code.
    throw new KnowledgeBaseError(
      serverDetail(body) ?? `The knowledge base rejected the document (HTTP ${response.status}).`,
      response.status,
    );
  }

  const wire = body as {
    doc_id?: unknown;
    title?: unknown;
    chunk_count?: unknown;
    already_exists?: unknown;
  } | null;

  if (typeof wire?.doc_id !== "string" || typeof wire.chunk_count !== "number") {
    throw new KnowledgeBaseError(
      "The knowledge base returned a response this panel does not understand.",
      response.status,
    );
  }

  return {
    docId: wire.doc_id,
    title: typeof wire.title === "string" ? wire.title : "",
    chunkCount: wire.chunk_count,
    alreadyExists: wire.already_exists === true,
  };
}
