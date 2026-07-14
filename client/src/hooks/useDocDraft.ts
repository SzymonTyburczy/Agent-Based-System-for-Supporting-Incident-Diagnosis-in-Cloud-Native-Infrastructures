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
      sourceFormat: parsed.sourceFormat ?? null,
      engine: parsed.engine ?? null,
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
  } catch {}
}

export function useDocDraftPersistence(draft: DocDraft): void {
  useEffect(() => {
    const id = setTimeout(() => saveDocDraft(draft), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draft]);
}
