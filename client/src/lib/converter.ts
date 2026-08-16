import { format } from "date-fns";
import { getConverterToken, getConverterUrl } from "./settings";
import type { DocumentPayload, SourceFormat } from "./types";

export type ConversionEngine = "docling" | "passthrough";

export interface ConversionResult {
  markdown: string;
  sourceFormat: SourceFormat;
  engine: ConversionEngine;
}

/** Mirrors doc-converter's own MAX_UPLOAD_BYTES, so an oversized file is
 * rejected before it is uploaded rather than after. */
export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];
const TEXT_EXTENSIONS = [".txt"];

/**
 * Single source of truth for accepted file types — feeds both the dropzone
 * `accept` option and detectSourceFormat below.
 */
export const ACCEPTED_FILE_TYPES: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "text/markdown": MARKDOWN_EXTENSIONS,
  "text/plain": TEXT_EXTENSIONS,
};

/** Backend contract uses day precision for the `data` field. */
export const PAYLOAD_DATE_FORMAT = "yyyy-MM-dd";

// A PDF page takes roughly half a second on CPU, and a long document runs into
// minutes — this is not a network timeout, it is a compute one.
const CONVERSION_TIMEOUT_MS = 180_000;

export function detectSourceFormat(file: File): SourceFormat | null {
  const lower = file.name.toLowerCase();
  if (file.type === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "markdown";
  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext)) || file.type.startsWith("text/")) {
    return "text";
  }
  return null;
}

async function convertPdfWithService(file: File): Promise<string> {
  const baseUrl = getConverterUrl();
  if (!baseUrl) {
    throw new Error(
      "VITE_CONVERTER_URL is not set — point it at the doc-converter service (see doc-converter/README.md).",
    );
  }

  const body = new FormData();
  body.append("file", file);
  const token = getConverterToken();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/convert`, {
      method: "POST",
      body,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(CONVERSION_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("The converter did not finish in time. Try a shorter document.");
    }
    throw new Error(`Could not reach the document converter at ${baseUrl}. Is it running?`);
  }

  const payload = (await response.json().catch(() => null)) as {
    markdown?: unknown;
    error?: unknown;
  } | null;

  if (!response.ok) {
    // The service explains every rejection it makes — too large, not a PDF,
    // no text extracted — so its message beats a bare status code.
    const message = typeof payload?.error === "string" ? payload.error : null;
    throw new Error(message ?? `The converter failed with HTTP ${response.status}.`);
  }

  if (typeof payload?.markdown !== "string" || !payload.markdown.trim()) {
    throw new Error("The converter returned an empty document.");
  }
  return payload.markdown;
}

/**
 * Converts any supported file to Markdown.
 * - PDF: sent to the local doc-converter service.
 * - Markdown / plain text: returned as-is (passthrough).
 *
 * The passthrough is not an optimisation — it is the only way a file stays
 * byte-exact. Docling would re-parse an already-valid Markdown document and
 * reflow it, which is why the service refuses these formats outright.
 */
export async function convertToMarkdown(file: File): Promise<ConversionResult> {
  const sourceFormat = detectSourceFormat(file);

  if (sourceFormat === "pdf") {
    const markdown = await convertPdfWithService(file);
    return { markdown, sourceFormat, engine: "docling" };
  }

  if (sourceFormat) {
    const markdown = (await file.text()).trim();
    if (!markdown) {
      throw new Error("The file is empty.");
    }
    return { markdown, sourceFormat, engine: "passthrough" };
  }

  throw new Error(`Unsupported file format: ${file.name}`);
}

export function buildPayload(params: {
  markdown: string;
  author: string;
  date?: Date;
}): DocumentPayload {
  return {
    data: format(params.date ?? new Date(), PAYLOAD_DATE_FORMAT),
    autor: params.author.trim(),
    tresc: params.markdown,
  };
}
