import { useCallback } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { FileText, FileType2, Loader2, Sparkles, Upload, X } from "lucide-react";
import { ACCEPTED_FILE_TYPES, MAX_FILE_SIZE_BYTES, type ConversionEngine } from "../lib/converter";
import type { SourceFormat } from "../lib/types";

export type UploadStatus = "idle" | "converting" | "ready" | "error";

const engineLabel: Record<ConversionEngine, string> = {
  docling: "Docling (local)",
  passthrough: "No conversion (Markdown / text)",
};

interface UploadZoneProps {
  status: UploadStatus;
  fileName: string;
  sourceFormat: SourceFormat | null;
  engine: ConversionEngine | null;
  onFile: (file: File) => void;
  onReject: (message: string) => void;
  onReset: () => void;
}

export function UploadZone({
  status,
  fileName,
  sourceFormat,
  engine,
  onFile,
  onReject,
  onReset,
}: UploadZoneProps) {
  const onDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      if (accepted.length > 0) {
        onFile(accepted[0]);
        return;
      }
      const rejection = rejections[0];
      if (rejection) {
        const tooLarge = rejection.errors.some((e) => e.code === "file-too-large");
        onReject(
          tooLarge
            ? `File is too large (max ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB).`
            : (rejection.errors[0]?.message ?? "This file cannot be processed."),
        );
      }
    },
    [onFile, onReject],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    multiple: false,
    noClick: true,
    noKeyboard: true,
    maxSize: MAX_FILE_SIZE_BYTES,
    // Reject new drops while a conversion is running — a second file racing the
    // first would pair one file's name with another file's content.
    disabled: status === "converting",
    accept: ACCEPTED_FILE_TYPES,
  });

  return (
    <div
      {...getRootProps()}
      className={[
        "relative flex min-h-56 flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition-colors",
        isDragActive
          ? "border-[var(--color-brand)] bg-[var(--color-brand)]/5"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-brand)]/50",
      ].join(" ")}
    >
      <input {...getInputProps()} />

      {status === "converting" ? (
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--color-brand)]" />
          <p className="text-sm text-[var(--color-muted)]">
            Processing <span className="text-white">{fileName}</span>…
          </p>
        </div>
      ) : status === "ready" ? (
        <div className="flex w-full flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-success)]/15">
            {sourceFormat === "pdf" ? (
              <FileType2 className="h-6 w-6 text-[var(--color-success)]" />
            ) : (
              <FileText className="h-6 w-6 text-[var(--color-success)]" />
            )}
          </div>
          <div>
            <p className="text-sm font-medium text-white">{fileName}</p>
            <p className="mt-0.5 flex items-center justify-center gap-1.5 text-xs text-[var(--color-muted)]">
              <Sparkles className="h-3 w-3" />
              {engine ? engineLabel[engine] : ""}
            </p>
          </div>
          <div className="mt-1 flex gap-2">
            <button
              onClick={open}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-surface-2)]"
            >
              Change file
            </button>
            <button
              onClick={onReset}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] hover:text-white"
            >
              <X className="h-3.5 w-3.5" /> Clear
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-surface-2)]">
            <Upload className="h-6 w-6 text-[var(--color-brand)]" />
          </div>
          <div>
            <p className="text-sm font-medium text-white">Drag and drop a file here</p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Supported formats: PDF, Markdown (.md), text (.txt)
            </p>
          </div>
          <button
            onClick={open}
            className="mt-1 rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand)]/90"
          >
            Choose from computer
          </button>
        </div>
      )}
    </div>
  );
}
