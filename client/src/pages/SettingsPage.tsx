import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import {
  getDefaultAuthor,
  getGeminiApiKey,
  getGeminiModel,
  setDefaultAuthor,
  setGeminiModel,
} from "../lib/settings";
import { listGeminiModels, type GeminiModel } from "../lib/models";
import { useTransientFlag } from "../hooks/useTransientFlag";

export function SettingsPage() {
  const apiKey = getGeminiApiKey();
  const [model, setModel] = useState(getGeminiModel());
  const [author, setAuthor] = useState(getDefaultAuthor());
  const { flag: saved, trigger: markSaved } = useTransientFlag(1800);

  const [models, setModels] = useState<GeminiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");

  const loadModels = useCallback(async () => {
    if (!apiKey) {
      setModels([]);
      setModelsError("");
      return;
    }
    setModelsLoading(true);
    setModelsError("");
    try {
      const list = await listGeminiModels(apiKey);
      setModels(list);
    } catch (err) {
      setModels([]);
      setModelsError(err instanceof Error ? err.message : "Failed to load models.");
    } finally {
      setModelsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const save = () => {
    setGeminiModel(model);
    setDefaultAuthor(author);
    // Re-read what was actually persisted (a blank model falls back to the
    // default), so the inputs never show a value that differs from storage.
    setModel(getGeminiModel());
    setAuthor(getDefaultAuthor());
    markSaved();
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Configure the Google Gemini integration and default document metadata."
      />

      <div className="max-w-2xl space-y-6">
        <div className="card p-6">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-[var(--color-brand)]" />
            <h3 className="text-sm font-semibold text-white">Google Gemini</h3>
          </div>

          <div className="flex items-center gap-2 rounded-lg bg-[var(--color-bg)] px-3 py-2.5 text-sm">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                apiKey ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]"
              }`}
            />
            <span className="text-[var(--color-muted)]">
              {apiKey
                ? "API key configured via VITE_GEMINI_API_KEY."
                : "No API key. Set VITE_GEMINI_API_KEY in client/.env and restart the dev server."}
            </span>
          </div>
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs text-[var(--color-brand)] hover:underline"
          >
            Get a key in Google AI Studio <ExternalLink className="h-3 w-3" />
          </a>

          <div className="mt-5 mb-1.5 flex items-center justify-between">
            <label
              htmlFor="gemini-model"
              className="block text-xs font-medium text-[var(--color-muted)]"
            >
              Model
            </label>
            <button
              type="button"
              onClick={() => void loadModels()}
              disabled={!apiKey || modelsLoading}
              className="flex items-center gap-1 text-xs text-[var(--color-brand)] hover:underline disabled:opacity-40 disabled:hover:no-underline"
            >
              {modelsLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Refresh
            </button>
          </div>

          {models.length === 0 ? (
            <input
              id="gemini-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Model id, e.g. gemini-flash-latest"
              className="input"
            />
          ) : (
            <select
              id="gemini-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="input"
            >
              {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName} ({m.id})
                </option>
              ))}
            </select>
          )}

          {modelsError ? (
            <p role="alert" className="mt-1.5 text-xs text-[var(--color-danger)]">
              {modelsError}
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-[var(--color-muted)]">
              {apiKey
                ? modelsLoading
                  ? "Loading available models…"
                  : `${models.length} model(s) available for this key.`
                : "Configure an API key to load available models."}
            </p>
          )}
        </div>

        <div className="card p-6">
          <h3 className="mb-4 text-sm font-semibold text-white">Default metadata</h3>
          <label
            htmlFor="default-author"
            className="mb-1.5 block text-xs font-medium text-[var(--color-muted)]"
          >
            Default author
          </label>
          <input
            id="default-author"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Author name"
            className="input"
          />
        </div>

        <button
          onClick={save}
          className="flex items-center gap-2 rounded-lg bg-[var(--color-brand)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-brand)]/90"
        >
          {saved ? (
            <>
              <Check className="h-4 w-4" /> Saved
            </>
          ) : (
            "Save settings"
          )}
        </button>
      </div>
    </div>
  );
}
