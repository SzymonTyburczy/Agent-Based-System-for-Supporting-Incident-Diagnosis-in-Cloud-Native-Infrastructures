import { useCallback } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Upload } from "lucide-react";
import { ACCEPTED_FILE_TYPES, MAX_FILE_SIZE_BYTES } from "../lib/converter";

interface UploadZoneProps {
  onFiles: (files: File[]) => void;
  /** One line per refused file (too large, unsupported format). */
  onReject: (messages: string[]) => void;
}

function rejectionMessage({ file, errors }: FileRejection): string {
  if (errors.some((error) => error.code === "file-too-large")) {
    return `${file.name}: the file is too large (max ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB).`;
  }
  if (errors.some((error) => error.code === "file-invalid-type")) {
    return `${file.name}: unsupported format.`;
  }
  return `${file.name}: ${errors[0]?.message ?? "this file cannot be processed."}`;
}

/**
 * Takes any number of files at any time — each one joins the upload queue, so
 * there is nothing to wait for before dropping the next.
 */
export function UploadZone({ onFiles, onReject }: UploadZoneProps) {
  const onDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      if (accepted.length > 0) onFiles(accepted);
      onReject(rejections.map(rejectionMessage));
    },
    [onFiles, onReject],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    multiple: true,
    noClick: true,
    noKeyboard: true,
    maxSize: MAX_FILE_SIZE_BYTES,
    accept: ACCEPTED_FILE_TYPES,
  });

  return (
    <div
      {...getRootProps()}
      className={[
        "flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition-colors",
        isDragActive
          ? "border-[var(--color-brand)] bg-[var(--color-brand)]/5"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-brand)]/50",
      ].join(" ")}
    >
      <input {...getInputProps()} />
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-surface-2)]">
        <Upload className="h-5 w-5 text-[var(--color-brand)]" />
      </div>
      <div>
        <p className="text-sm font-medium text-white">Drag and drop files here</p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          PDF, Markdown (.md) or text (.txt) — several at once, and more while others are processed
        </p>
      </div>
      <button
        onClick={open}
        className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand)]/90"
      >
        Choose from computer
      </button>
    </div>
  );
}
