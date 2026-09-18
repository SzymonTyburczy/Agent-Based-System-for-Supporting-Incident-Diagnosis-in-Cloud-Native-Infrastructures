import { useState } from "react";
import { Check } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { getDefaultAuthor, setDefaultAuthor } from "../lib/settings";
import { useTransientFlag } from "../hooks/useTransientFlag";

export function SettingsPage() {
  const [author, setAuthor] = useState(getDefaultAuthor());
  const { flag: saved, trigger: markSaved } = useTransientFlag(1800);

  const save = () => {
    setDefaultAuthor(author);
    // Re-read what was actually persisted, so the input never shows a value
    // that differs from storage.
    setAuthor(getDefaultAuthor());
    markSaved();
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Default document metadata. Conversion and model settings live in the doc-converter service, not here."
      />

      <div className="max-w-2xl space-y-6">
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
