import type { ReactNode } from "react";
import { AlertTriangle, Clock, RefreshCw, ServerCog } from "lucide-react";
import { formatIssueDate, formatUtcTimestamp } from "../lib/format";

/** Dashed placeholder used for every "nothing here / still loading" state.
 * `status` marks the loading variant for screen readers. */
export function EmptyCard({ children, status }: { children: ReactNode; status?: boolean }) {
  return (
    <div
      role={status ? "status" : undefined}
      className="card flex flex-col items-center justify-center border-dashed py-16 text-center"
    >
      <p className="text-sm text-[var(--color-muted)]">{children}</p>
    </div>
  );
}

/** Full-height failure state, for when there is nothing else to show. */
export function ErrorCard({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="card flex flex-col items-center gap-2 border-[var(--color-danger)]/40 py-16 text-center"
    >
      <AlertTriangle className="h-5 w-5 text-[var(--color-danger)]" />
      <p className="text-sm text-[var(--color-danger)]">{title}</p>
      {detail && <p className="text-xs text-[var(--color-muted)]">{detail}</p>}
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary mt-2">
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      )}
    </div>
  );
}

/** Inline banner for when a refresh failed but the data on screen is still
 * worth showing — blanking it would be the bigger lie. */
export function StaleBanner({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail?: string | null;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-2 text-xs text-[var(--color-danger)]"
    >
      {message}
      {detail && <span className="text-[var(--color-muted)]">{detail}</span>}
      <button onClick={onRetry} className="btn-secondary ml-auto">
        <RefreshCw className="h-3.5 w-3.5" /> Retry
      </button>
    </div>
  );
}

/** service + timestamp, identical on the issue card and the detail header. */
export function IssueMeta({ service, createdAt }: { service: string; createdAt: string }) {
  return (
    <>
      <span className="flex items-center gap-1">
        <ServerCog className="h-3.5 w-3.5" />
        {service || "unknown service"}
      </span>
      <span className="flex items-center gap-1">
        <Clock className="h-3.5 w-3.5" />
        <time dateTime={createdAt} title={formatUtcTimestamp(createdAt)}>
          {formatIssueDate(createdAt)}
        </time>
      </span>
    </>
  );
}
