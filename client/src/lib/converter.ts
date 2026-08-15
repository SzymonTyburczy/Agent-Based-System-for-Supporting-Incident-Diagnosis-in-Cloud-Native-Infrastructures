import { GoogleGenAI } from "@google/genai";
import { format } from "date-fns";
import { getGeminiApiKey, getGeminiModel } from "./settings";
import type { DocumentPayload, SourceFormat } from "./types";

export type ConversionEngine = "gemini" | "passthrough";

export interface ConversionResult {
  markdown: string;
  sourceFormat: SourceFormat;
  engine: ConversionEngine;
}

// Gemini inline data is limited to ~20 MB per request; leave headroom for the base64 overhead.
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

export function detectSourceFormat(file: File): SourceFormat | null {
  const lower = file.name.toLowerCase();
  if (file.type === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "markdown";
  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext)) || file.type.startsWith("text/")) {
    return "text";
  }
  return null;
}

async function fileToBase64(file: File): Promise<string> {
  // FileReader encodes natively, off the JS main loop — no multi-MB intermediate
  // strings and no UI freeze on large PDFs.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read the file."));
    reader.readAsDataURL(file);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

const GEMINI_PROMPT = `You are a precise document converter. Convert the attached PDF file into clean Markdown.
Rules:
- Preserve structure: headings (#, ##, ...), lists, tables (GFM), code blocks and blockquotes.
- Do not add your own comments, intros or summaries.
- Do not wrap the whole response in a code block.
- Return only the Markdown content.`;

const RETRYABLE_STATUS = [429, 503];
const MAX_RETRIES = 3;

function isRetryable(err: unknown): boolean {
  // The @google/genai ApiError carries a numeric status — prefer it over message sniffing.
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    return RETRYABLE_STATUS.includes(status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return (
    RETRYABLE_STATUS.some((code) => new RegExp(`\\b${code}\\b`).test(message)) ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(message)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function convertPdfWithGemini(file: File): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      "Missing Gemini API key. Set VITE_GEMINI_API_KEY in client/.env and restart the dev server to convert PDF files.",
    );
  }

  const ai = new GoogleGenAI({ apiKey });
  const base64 = await fileToBase64(file);

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: getGeminiModel(),
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "application/pdf", data: base64 } },
              { text: GEMINI_PROMPT },
            ],
          },
        ],
      });

      const text = (response.text ?? "").trim();
      if (!text) {
        throw new Error("Gemini returned no content for this PDF file.");
      }
      return text;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES && isRetryable(err)) {
        // Exponential backoff: 1s, 2s, 4s.
        await delay(1000 * 2 ** attempt);
        continue;
      }
      if (isRetryable(err)) {
        throw new Error(
          "The Gemini model is temporarily overloaded (high demand). Please try again in a moment, or pick a different model in Settings.",
        );
      }
      throw err;
    }
  }

  throw lastError;
}

/**
 * Converts any supported file to Markdown.
 * - PDF: converted via Google Gemini (requires an API key).
 * - Markdown / plain text: returned as-is (passthrough).
 */
export async function convertToMarkdown(file: File): Promise<ConversionResult> {
  const sourceFormat = detectSourceFormat(file);

  if (sourceFormat === "pdf") {
    const markdown = await convertPdfWithGemini(file);
    return { markdown, sourceFormat, engine: "gemini" };
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
