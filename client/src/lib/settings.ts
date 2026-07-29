const STORAGE_KEYS = {
  geminiModel: "idar.geminiModel",
  defaultAuthor: "idar.defaultAuthor",
} as const;

export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

export function getGeminiApiKey(): string {
  return (import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();
}

export function getAgentApiUrl(): string {
  return (import.meta.env.VITE_AGENT_API_URL ?? "").trim().replace(/\/+$/, "");
}

export function getAgentApiToken(): string {
  return (import.meta.env.VITE_AGENT_API_TOKEN ?? "").trim();
}

export function getGeminiModel(): string {
  return localStorage.getItem(STORAGE_KEYS.geminiModel) || DEFAULT_GEMINI_MODEL;
}

export function setGeminiModel(value: string): void {
  localStorage.setItem(STORAGE_KEYS.geminiModel, value.trim() || DEFAULT_GEMINI_MODEL);
}

export function getDefaultAuthor(): string {
  return localStorage.getItem(STORAGE_KEYS.defaultAuthor) || "";
}

export function setDefaultAuthor(value: string): void {
  localStorage.setItem(STORAGE_KEYS.defaultAuthor, value.trim());
}
