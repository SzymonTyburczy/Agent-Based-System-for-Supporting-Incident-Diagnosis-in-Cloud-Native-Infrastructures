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

export function getDefaultAuthor(): string {
  return localStorage.getItem(STORAGE_KEYS.defaultAuthor) || "";
}

export function setDefaultAuthor(value: string): void {
  localStorage.setItem(STORAGE_KEYS.defaultAuthor, value.trim());
}
