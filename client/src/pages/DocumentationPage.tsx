import { useCallback, useMemo, useRef, useState } from "react";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { Check, Copy, Send } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { UploadZone, type UploadStatus } from "../components/UploadZone";
import {
  buildPayload,
  convertToMarkdown,
  PAYLOAD_DATE_FORMAT,
  type ConversionEngine,
} from "../lib/converter";
import { getDefaultAuthor } from "../lib/settings";
import {
  clearDocDraft,
  loadDocDraft,
  useDocDraftPersistence,
  type DocDraft,
} from "../hooks/useDocDraft";
import { useTransientFlag } from "../hooks/useTransientFlag";
import type { DocumentPayload, SourceFormat } from "../lib/types";

type RightTab = "preview" | "json";

export function DocumentationPage() {
  const [draft] = useState(() => loadDocDraft());
  const [status, setStatus] = useState<UploadStatus>(draft?.status ?? "idle");
  const [fileName, setFileName] = useState(draft?.fileName ?? "");
  const [sourceFormat, setSourceFormat] = useState<SourceFormat | null>(
    draft?.sourceFormat ?? null,
  );
  const [engine, setEngine] = useState<ConversionEngine | null>(draft?.engine ?? null);
  const [markdown, setMarkdown] = useState(draft?.markdown ?? "");
  // `||` (not `??`): an empty author persisted in the draft must not shadow
  // the default author configured later in Settings.
  const [author, setAuthor] = useState(draft?.author || getDefaultAuthor());
  const [date, setDate] = useState<Date>(() =>
    draft?.dateISO ? new Date(draft.dateISO) : new Date(),
  );
  const [error, setError] = useState("");
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const { flag: copied, trigger: markCopied } = useTransientFlag(1500);
  const { flag: sent, trigger: markSent, clear: clearSent } = useTransientFlag(2500);
  // Guards against a slow conversion resolving after a newer one started.
  const conversionId = useRef(0);

  const currentDraft: DocDraft = useMemo(
    () => ({
      status: status === "ready" ? "ready" : "idle",
      fileName,
      sourceFormat,
      engine,
      markdown,
      author,
      dateISO: date.toISOString(),
    }),
    [status, fileName, sourceFormat, engine, markdown, author, date],
  );
  useDocDraftPersistence(currentDraft);

  const handleFile = useCallback(
    async (file: File) => {
      const id = ++conversionId.current;
      setError("");
      clearSent();
      setStatus("converting");
      setFileName(file.name);
      // Drop the previous file's result up front, so a failure never shows the
      // old content under the new file's name.
      setMarkdown("");
      setSourceFormat(null);
      setEngine(null);
      try {
        const result = await convertToMarkdown(file);
        if (id !== conversionId.current) return;
        setMarkdown(result.markdown);
        setSourceFormat(result.sourceFormat);
        setEngine(result.engine);
        setStatus("ready");
        setRightTab("preview");
      } catch (err) {
        if (id !== conversionId.current) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to process the file.");
      }
    },
    [clearSent],
  );

  const payload: DocumentPayload = useMemo(
    () => buildPayload({ markdown, author, date }),
    [markdown, author, date],
  );

  // Serializing a multi-MB document on every keystroke is wasted work while the
  // JSON tab is hidden — compute only when it is actually displayed.
  const payloadJson = useMemo(
    () => (rightTab === "json" ? JSON.stringify(payload, null, 2) : ""),
    [payload, rightTab],
  );

  const reset = () => {
    conversionId.current++;
    setStatus("idle");
    setFileName("");
    setSourceFormat(null);
    setEngine(null);
    setMarkdown("");
    setError("");
    setDate(new Date());
    clearSent();
    clearDocDraft();
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      markCopied();
    } catch {
      setError("Could not copy to the clipboard. Copy the JSON manually from the panel.");
    }
  };

  const canSubmit = status === "ready" && markdown.trim().length > 0 && author.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    // Stand-in for the future backend request: log the payload that would be
    // sent, then clear the form.
    console.info("Sending document payload:\n", JSON.stringify(payload, null, 2));
    reset();
    markSent();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0">
        <PageHeader
          title="Documentation"
          description="Add documentation (PDF or Markdown) to the RAG knowledge base. PDF files are automatically converted to Markdown with Google Gemini."
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
        {/* Left column: upload + form (fixed, non-scrolling) */}
        <div className="space-y-4 lg:w-1/2">
          <UploadZone
            status={status}
            fileName={fileName}
            sourceFormat={sourceFormat}
            engine={engine}
            onFile={(file) => void handleFile(file)}
            onReject={setError}
            onReset={reset}
          />

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]"
            >
              {error}
            </div>
          )}

          <div className="card p-5">
            <h3 className="mb-4 text-sm font-semibold text-white">Document metadata</h3>
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="doc-author"
                  className="mb-1.5 block text-xs font-medium text-[var(--color-muted)]"
                >
                  Author
                </label>
                <input
                  id="doc-author"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="Author name"
                  className="input"
                />
              </div>
              <div>
                <label
                  htmlFor="doc-date"
                  className="mb-1.5 block text-xs font-medium text-[var(--color-muted)]"
                >
                  Date
                </label>
                <DatePicker
                  id="doc-date"
                  selected={date}
                  onChange={(value: Date | null) => value && setDate(value)}
                  dateFormat={PAYLOAD_DATE_FORMAT}
                  wrapperClassName="w-full"
                  className="input"
                />
              </div>
            </div>

            <button
              onClick={handleSubmit}
              disabled={!canSubmit && !sent}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-brand)] to-[var(--color-brand-2)] px-4 py-2.5 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sent ? (
                <>
                  <Check className="h-4 w-4" /> Sent
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" /> Send
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right column: preview / JSON (only this panel scrolls) */}
        <div className="card flex min-h-0 flex-col lg:h-full lg:w-1/2">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
            <div className="flex gap-1">
              {(["preview", "json"] as RightTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setRightTab(tab)}
                  aria-pressed={rightTab === tab}
                  className={[
                    "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    rightTab === tab
                      ? "bg-[var(--color-surface-2)] text-white"
                      : "text-[var(--color-muted)] hover:text-white",
                  ].join(" ")}
                >
                  {tab === "preview" ? "Preview" : "JSON payload"}
                </button>
              ))}
            </div>
            {rightTab === "json" && (
              <button onClick={copyJson} className="btn-secondary">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>

          <div className="min-h-[420px] flex-1 overflow-auto p-5 lg:min-h-0">
            {rightTab === "preview" ? (
              status !== "ready" ? (
                <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
                  Add a file to see the preview.
                </div>
              ) : sourceFormat === "text" ? (
                <pre className="text-sm leading-relaxed break-words whitespace-pre-wrap text-[#e6ebf3]">
                  {markdown}
                </pre>
              ) : (
                <MarkdownPreview content={markdown} />
              )
            ) : (
              <pre className="text-xs leading-relaxed break-words whitespace-pre-wrap text-[var(--color-muted)]">
                <code>{payloadJson}</code>
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
