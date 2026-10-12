const STORAGE_KEYS = {
  defaultAuthor: "idar.defaultAuthor",
} as const;

export function getAgentApiUrl(): string {
  return (import.meta.env.VITE_AGENT_API_URL ?? "").trim().replace(/\/+$/, "");
}

export function getAgentApiToken(): string {
  return (import.meta.env.VITE_AGENT_API_TOKEN ?? "").trim();
}

/** Base URL of the local doc-converter service (see doc-converter/README.md). */
export function getConverterUrl(): string {
  return (import.meta.env.VITE_CONVERTER_URL ?? "").trim().replace(/\/+$/, "");
}

export function getConverterToken(): string {
  return (import.meta.env.VITE_CONVERTER_TOKEN ?? "").trim();
}

/** Base URL of the RAG knowledge base (see server/README.md). */
export function getRagApiUrl(): string {
  return (import.meta.env.VITE_RAG_API_URL ?? "").trim().replace(/\/+$/, "");
}

export function getRagApiToken(): string {
  return (import.meta.env.VITE_RAG_API_TOKEN ?? "").trim();
}

// Storage access throws when the browser blocks site data for this origin. This
// is read during render, so it must degrade to "no default" rather than take the
// page down with it.
export function getDefaultAuthor(): string {
  try {
    return localStorage.getItem(STORAGE_KEYS.defaultAuthor) || "";
  } catch {
    return "";
  }
}

/** Returns false when storage is unavailable and the default was not saved. */
export function setDefaultAuthor(value: string): boolean {
  try {
    localStorage.setItem(STORAGE_KEYS.defaultAuthor, value.trim());
    return true;
  } catch {
    return false;
  }
}
