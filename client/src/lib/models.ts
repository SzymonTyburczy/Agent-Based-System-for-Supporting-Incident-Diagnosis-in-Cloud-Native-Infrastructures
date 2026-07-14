export interface GeminiModel {
  id: string;
  displayName: string;
}

interface RawModel {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

/**
 * Fetches Gemini models available to the given API key via the ListModels REST
 * endpoint, keeping only text models that support `generateContent`.
 */
export async function listGeminiModels(apiKey: string): Promise<GeminiModel[]> {
  const url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";

  const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message || `Failed to load models (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as { models?: RawModel[] };
  return (data.models ?? [])
    .filter(
      (m) =>
        m.name.startsWith("models/gemini") &&
        (m.supportedGenerationMethods?.includes("generateContent") ?? false),
    )
    .map((m) => ({
      id: m.name.replace(/^models\//, ""),
      displayName: m.displayName || m.name.replace(/^models\//, ""),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
