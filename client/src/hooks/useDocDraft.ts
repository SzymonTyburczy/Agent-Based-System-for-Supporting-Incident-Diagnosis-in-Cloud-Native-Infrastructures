import { useEffect } from "react";
import type { ConversionEngine } from "../lib/converter";
import type { SourceFormat } from "../lib/types";

const DRAFT_KEY = "idar.docDraft";
const SAVE_DEBOUNCE_MS = 400;

export interface DocDraft {
  status: "idle" | "ready";
  fileName: string;
  sourceFormat: SourceFormat | null;
  engine: ConversionEngine | null;
  markdown: string;
  author: string;
  dateISO: string;
}

function parseSourceFormat(value: unknown): SourceFormat | null {
  return value === "pdf" || value === "markdown" || value === "text" ? value : null;
}

function parseEngine(value: unknown): ConversionEngine | null {
  return value === "gemini" || value === "passthrough" ? value : null;
}

export function loadDocDraft(): DocDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DocDraft>;
    if (
      typeof parsed.markdown !== "string" ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.author !== "string" ||
      typeof parsed.dateISO !== "string" ||
      Number.isNaN(new Date(parsed.dateISO).getTime())
    ) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return {
      status: parsed.status === "ready" ? "ready" : "idle",
      fileName: parsed.fileName,
      sourceFormat: parseSourceFormat(parsed.sourceFormat),
      engine: parseEngine(parsed.engine),
      markdown: parsed.markdown,
      author: parsed.author,
      dateISO: parsed.dateISO,
    };
  } catch {
    return null;
  }
}

export function clearDocDraft(): void {
  localStorage.removeItem(DRAFT_KEY);
}

function saveDocDraft(draft: DocDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota exceeded (huge converted document) or storage unavailable — drop the
    // stale draft rather than keep one that no longer matches the screen.
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Storage fully unavailable — nothing to clean up.
    }
  }
}

/**
 * Persists the given draft to localStorage, debounced. A draft with no document
 * and no author is removed instead of saved, so Clear/Send stays cleared.
 */
export function useDocDraftPersistence(draft: DocDraft): void {
  useEffect(() => {
    const id = setTimeout(() => {
      const empty = draft.status === "idle" && !draft.fileName && !draft.markdown && !draft.author;
      if (empty) {
        localStorage.removeItem(DRAFT_KEY);
      } else {
        saveDocDraft(draft);
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draft]);
}
