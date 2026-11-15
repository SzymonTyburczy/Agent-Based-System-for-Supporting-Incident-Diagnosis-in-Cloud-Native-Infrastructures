import { useCallback, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { Check, Loader2 } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { UploadZone } from "../components/UploadZone";
import { UploadList } from "../components/UploadList";
import { PAYLOAD_DATE_FORMAT } from "../lib/converter";
import { isEditable, type UploadItem } from "../lib/uploadQueue";
import { useUploadQueue } from "../hooks/uploadQueueContext";

type RightTab = "preview" | "edit";

/** The explicit selection, else the first document awaiting approval, else the newest. */
function pickSelected(items: readonly UploadItem[], selectedId: string | null): UploadItem | null {
  return (
    items.find((item) => item.id === selectedId) ??
    items.find((item) => item.stage === "ready") ??
    items.at(-1) ??
    null
  );
}

function Placeholder({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-[var(--color-muted)]">
      {busy && <Loader2 className="h-6 w-6 animate-spin text-[var(--color-brand)]" />}
      <div>{children}</div>
    </div>
  );
}

export function DocumentationPage() {
  const { queue, state } = useUploadQueue();
  const { items, author, date } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [rejections, setRejections] = useState<string[]>([]);

  const selected = pickSelected(items, selectedId);
  const authorMissing = !author.trim();
  const waitingForAuthor = items.filter((item) => item.stage === "approved").length;

  const addFiles = useCallback((files: File[]) => queue.add(files), [queue]);

  const select = (id: string) => {
    setSelectedId(id);
    setRightTab("preview");
  };

  const renderBody = (item: UploadItem) => {
    if (item.markdown) {
      if (rightTab === "edit") {
        return (
          // Edits go straight into the queue, so what you see here is what gets
          // sent — and the queue keeps them in localStorage across a refresh.
          // This is the repair path for the one thing the converter gets wrong:
          // multi-line YAML and code blocks arrive flattened onto one line.
          <textarea
            value={item.markdown}
            onChange={(event) => queue.editMarkdown(item.id, event.target.value)}
            readOnly={!isEditable(item)}
            spellCheck={false}
            aria-label="Markdown content"
            className="min-h-[420px] w-full flex-1 resize-none bg-transparent font-mono text-xs leading-relaxed text-[#e6ebf3] outline-none read-only:opacity-70 lg:min-h-0"
          />
        );
      }
      // .txt is not Markdown — rendering it as such would invent structure the
      // author never wrote.
      return item.sourceFormat === "text" ? (
        <pre className="text-sm leading-relaxed break-words whitespace-pre-wrap text-[#e6ebf3]">
          {item.markdown}
        </pre>
      ) : (
        <MarkdownPreview content={item.markdown} />
      );
    }
    switch (item.stage) {
      case "queued":
        return (
          <Placeholder>Waiting for the converter — PDFs are converted one at a time.</Placeholder>
        );
      case "converting":
        return <Placeholder busy>Converting {item.fileName}…</Placeholder>;
      case "error":
        return <Placeholder>{item.error || "Processing failed."}</Placeholder>;
      case "done":
        // Restored after a reload: the text was not kept, it is in the knowledge base.
        return (
          <Placeholder>
            Sent to the knowledge base.{" "}
            {item.result && (
              <Link
                to={`/knowledge-base?doc=${encodeURIComponent(item.result.docId)}`}
                className="text-[var(--color-brand)] hover:underline"
              >
                Open it there
              </Link>
            )}
          </Placeholder>
        );
      default:
        return <Placeholder>Nothing to show yet.</Placeholder>;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0">
        <PageHeader
          title="Documentation"
          description="Add documentation (PDF or Markdown) to the RAG knowledge base. Markdown and text files are sent right away. PDFs are converted to Markdown locally, by the doc-converter service, and wait for your review and approval."
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
        {/* Left column: upload, metadata, queue */}
        <div className="space-y-4 lg:w-1/2">
          <UploadZone onFiles={addFiles} onReject={setRejections} />

          {rejections.length > 0 && (
            <div
              role="alert"
              className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]"
            >
              {rejections.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          )}

          <div className="card p-5">
            <h3 className="mb-1 text-sm font-semibold text-white">Document metadata</h3>
            <p className="mb-4 text-xs text-[var(--color-muted)]">
              Applied to each document at the moment it is sent.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
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
                  onChange={(e) => queue.setAuthor(e.target.value)}
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
                  onChange={(value: Date | null) => value && queue.setDate(value)}
                  dateFormat={PAYLOAD_DATE_FORMAT}
                  wrapperClassName="w-full"
                  className="input"
                />
              </div>
            </div>
            {authorMissing && waitingForAuthor > 0 && (
              <p role="status" className="mt-3 text-xs text-[var(--color-warning)]">
                {waitingForAuthor} document{waitingForAuthor === 1 ? " is" : "s are"} waiting for an
                author before {waitingForAuthor === 1 ? "it is" : "they are"} sent.
              </p>
            )}
          </div>

          <UploadList
            items={items}
            selectedId={selected?.id ?? null}
            authorMissing={authorMissing}
            onSelect={select}
            onApprove={(id) => queue.approve(id)}
            onApproveAll={() => queue.approveAll()}
            onRetry={(id) => queue.retry(id)}
            onRemove={(id) => queue.remove(id)}
            onClearFinished={() => queue.clearFinished()}
          />
        </div>

        {/* Right column: preview / editor of the selected file (only this panel scrolls) */}
        <div className="card flex min-h-0 flex-col lg:h-full lg:w-1/2">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <div className="flex shrink-0 gap-1">
              {(["preview", "edit"] as RightTab[]).map((tab) => (
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
                  {tab === "preview" ? "Preview" : "Edit"}
                </button>
              ))}
            </div>
            {selected && (
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="truncate text-xs text-[var(--color-muted)]"
                  title={selected.fileName}
                >
                  {selected.fileName}
                  {rightTab === "edit" && selected.markdown
                    ? ` · ${selected.markdown.length.toLocaleString()} characters`
                    : ""}
                </span>
                {selected.stage === "ready" && (
                  <button
                    onClick={() => queue.approve(selected.id)}
                    disabled={!selected.markdown.trim()}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-r from-[var(--color-brand)] to-[var(--color-brand-2)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Check className="h-3.5 w-3.5" /> Approve
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex min-h-[420px] flex-1 flex-col overflow-auto p-5 lg:min-h-0">
            {selected ? (
              renderBody(selected)
            ) : (
              <Placeholder>Add files to see a preview.</Placeholder>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
