import { Check, CheckCheck, FileText, FileType2, Loader2, RotateCw, X } from "lucide-react";
import { describeUpload, type UploadItem, type UploadTone } from "../lib/uploadQueue";

interface UploadListProps {
  items: readonly UploadItem[];
  selectedId: string | null;
  /** Approved documents wait for an author before they are sent. */
  authorMissing: boolean;
  onSelect: (id: string) => void;
  onApprove: (id: string) => void;
  onApproveAll: () => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onClearFinished: () => void;
}

const toneClass: Record<UploadTone, string> = {
  muted: "text-[var(--color-muted)]",
  brand: "text-[var(--color-brand)]",
  warning: "text-[var(--color-warning)]",
  success: "text-[var(--color-success)]",
  danger: "text-[var(--color-danger)]",
};

function removeLabel(item: UploadItem): string {
  if (item.stage === "converting" || item.stage === "sending") return "Cancel";
  if (item.stage === "done")
    return "Remove from the list (the document stays in the knowledge base)";
  return "Remove";
}

export function UploadList({
  items,
  selectedId,
  authorMissing,
  onSelect,
  onApprove,
  onApproveAll,
  onRetry,
  onRemove,
  onClearFinished,
}: UploadListProps) {
  const readyCount = items.filter((item) => item.stage === "ready").length;
  const hasFinished = items.some((item) => item.stage === "done");

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">
          Uploads <span className="font-normal text-[var(--color-muted)]">({items.length})</span>
        </h3>
        <div className="flex gap-2">
          {readyCount > 1 && (
            <button onClick={onApproveAll} className="btn-secondary">
              <CheckCheck className="h-3.5 w-3.5" /> Approve all ({readyCount})
            </button>
          )}
          {hasFinished && (
            <button onClick={onClearFinished} className="btn-secondary">
              Clear finished
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="py-4 text-center text-xs text-[var(--color-muted)]">
          No files yet. Markdown and text files are sent as soon as they are read. PDFs are
          converted first and wait for your approval.
        </p>
      ) : (
        // Bounded so a long batch never pushes the metadata form off screen.
        <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
          {items.map((item) => {
            const status = describeUpload(item, authorMissing);
            const selected = item.id === selectedId;
            const Icon = item.sourceFormat === "pdf" ? FileType2 : FileText;
            return (
              <li
                key={item.id}
                className={[
                  "flex items-center gap-2 rounded-lg border px-2 py-1.5",
                  selected
                    ? "border-[var(--color-brand)]/60 bg-[var(--color-surface-2)]"
                    : "border-transparent hover:bg-[var(--color-surface-2)]/60",
                ].join(" ")}
              >
                <button
                  onClick={() => onSelect(item.id)}
                  aria-current={selected ? "true" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <Icon className={`h-4 w-4 shrink-0 ${toneClass[status.tone]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-white">
                      {item.fileName || "Untitled"}
                    </span>
                    <span
                      className={`flex items-center gap-1 text-[11px] ${toneClass[status.tone]}`}
                    >
                      {status.busy && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
                      <span className="truncate" title={status.text}>
                        {status.text}
                      </span>
                    </span>
                  </span>
                </button>

                {item.stage === "ready" && (
                  <button
                    onClick={() => onApprove(item.id)}
                    title="Approve and send to the knowledge base"
                    className="flex shrink-0 items-center gap-1 rounded-md bg-[var(--color-success)]/15 px-2 py-1 text-xs font-medium text-[var(--color-success)] hover:bg-[var(--color-success)]/25"
                  >
                    <Check className="h-3.5 w-3.5" /> Approve
                  </button>
                )}
                {item.stage === "error" && (
                  <button
                    onClick={() => onRetry(item.id)}
                    title="Retry"
                    aria-label={`Retry ${item.fileName}`}
                    className="shrink-0 rounded-md p-1 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-white"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  onClick={() => onRemove(item.id)}
                  title={removeLabel(item)}
                  aria-label={`${removeLabel(item)}: ${item.fileName}`}
                  className="shrink-0 rounded-md p-1 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
