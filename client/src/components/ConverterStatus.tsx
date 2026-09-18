import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useConverterHealth } from "../hooks/useConverterHealth";

/**
 * Sidebar indicator for the document converter's optional vision model.
 *
 * Deliberately read-only: no key is ever entered here. The key belongs to the
 * doc-converter service's own environment — putting it in the browser is what
 * this whole change set exists to undo. Clicking only explains where it goes.
 */
export function ConverterStatus() {
  const { reachable, figureDescriptions } = useConverterHealth();
  const [open, setOpen] = useState(false);

  const label = !reachable
    ? "Converter: offline"
    : figureDescriptions
      ? "AI model: connected"
      : "AI model: not connected";

  const dotColor = !reachable
    ? "bg-[var(--color-muted)]"
    : figureDescriptions
      ? "bg-[var(--color-success)]"
      : "bg-[var(--color-warning)]";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={label}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2.5 text-xs transition-colors hover:bg-[var(--color-border)] md:justify-start"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
        <span className="hidden text-[var(--color-muted)] md:inline">{label}</span>
      </button>

      {open && (
        <ConverterInfoDialog
          reachable={reachable}
          connected={figureDescriptions}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ConverterInfoDialog({
  reachable,
  connected,
  onClose,
}: {
  reachable: boolean;
  connected: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // Clicking the backdrop closes; clicking the panel must not bubble up to it.
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="converter-dialog-title"
        onClick={(event) => event.stopPropagation()}
        className="card w-full max-w-md p-6"
      >
        <div className="mb-3 flex items-start gap-3">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-brand)]" />
          <h2 id="converter-dialog-title" className="flex-1 text-sm font-semibold text-white">
            {connected ? "AI model connected" : "Optional: connect an AI model"}
          </h2>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-muted)] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!reachable ? (
          <p className="text-sm text-[var(--color-muted)]">
            The document converter is not responding. Start it with{" "}
            <code className="text-[var(--color-brand-2)]">python -m doc_converter.app</code> in{" "}
            <code className="text-[var(--color-brand-2)]">doc-converter/</code>, then reload this
            page.
          </p>
        ) : connected ? (
          <p className="text-sm text-[var(--color-muted)]">
            The converter has a vision model configured, so diagrams and screenshots in uploaded
            PDFs are described in the extracted Markdown.
          </p>
        ) : (
          <>
            <p className="text-sm text-[var(--color-muted)]">
              PDF conversion works fully without a model — headings, text and tables are extracted
              locally. Connecting a model only adds one thing:{" "}
              <span className="text-white">figures and diagrams get described in text</span> instead
              of being skipped.
            </p>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              The key belongs to the converter service, not to this panel. Set it in{" "}
              <code className="text-[var(--color-brand-2)]">doc-converter/.env</code> and restart
              the service:
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--color-bg)] p-3 text-xs text-[#e6ebf3]">
              {`ENABLE_PICTURE_DESCRIPTION=true\nVLM_API_KEY=<your key>`}
            </pre>
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Any OpenAI-compatible endpoint works — including a local Ollama, which needs no key at
              all. See <code>doc-converter/README.md</code>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
