import { useCallback, useEffect, useRef, useState } from "react";
import { describeAgentError, fetchIssue, isAbort, isNotFound, updateIssueStatus } from "../lib/api";
import type { WireProblem } from "../lib/reportWire";
import { selectProblemsForId } from "../lib/reportsState";
import type { IssueDetail, IssueSummary } from "../lib/types";
import { useReportsStore } from "./reportsContext";

export type IssueDetailStatus = "loading" | "ready" | "missing" | "error";

export interface UseIssueDetailResult {
  detail: IssueDetail | null;
  /** Cached from the list → the header paints instantly on a list→detail click. */
  summary: IssueSummary | null;
  status: IssueDetailStatus;
  error: string | null;
  /** Repairs recorded for THIS id only. */
  problems: WireProblem[];
  retry: () => void;
  updating: boolean;
  updateError: string | null;
  toggleStatus: () => void;
}

type FetchPhase = "loading" | "ready" | "missing" | "error";

/**
 * Reads one report out of the shared store and keeps it fresh, plus the
 * status write. Stale-while-revalidate: whatever the list already cached
 * paints immediately while the detail request runs behind it, so the common
 * list→detail click never shows a full-page spinner.
 */
export function useIssueDetail(id: string | undefined): UseIssueDetailResult {
  const { state, dispatch } = useReportsStore();
  const [phase, setPhase] = useState<FetchPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // The in-flight revalidating read, so a status write can supersede it.
  const readRef = useRef<AbortController | null>(null);

  const detail = id ? (state.details[id] ?? null) : null;
  const summary = id ? (state.issues.find((issue) => issue.id === id) ?? null) : null;

  useEffect(() => {
    // A missing route param used to bail out of the effect while `loading`
    // stayed true forever — a permanent spinner with nothing to explain it.
    if (!id) {
      setPhase("missing");
      return;
    }

    const controller = new AbortController();
    readRef.current = controller;
    setError(null);

    fetchIssue(id, { signal: controller.signal })
      .then((result) => {
        // A status write (or a route change) has superseded this read: its
        // body predates the PATCH, so applying it would revert the toggle.
        if (controller.signal.aborted) return;
        dispatch({ type: "detail_loaded", detail: result.issue, problems: result.problems });
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (isAbort(err) || controller.signal.aborted) return;
        if (isNotFound(err)) {
          setPhase("missing");
          return;
        }
        setError(describeAgentError(err));
        setPhase("error");
      });

    return () => {
      controller.abort();
      if (readRef.current === controller) readRef.current = null;
    };
  }, [id, reloadToken, dispatch]);

  const retry = useCallback(() => {
    setPhase("loading");
    setReloadToken((token) => token + 1);
  }, []);

  const current = detail ?? summary;

  const toggleStatus = useCallback(() => {
    if (!id || !current || updating) return;
    const nextStatus = current.status === "pending" ? "resolved" : "pending";
    // The PATCH response is authoritative; a read still in flight carries the
    // pre-write state and would otherwise land last and revert it.
    readRef.current?.abort();
    setUpdating(true);
    setUpdateError(null);

    // Not optimistic on purpose: the PATCH is a local round trip and the
    // server's own `report_updated` echo follows moments later. Briefly
    // showing an incident as resolved when the write failed is a worse lie
    // than 200ms of "Updating…".
    updateIssueStatus(id, nextStatus)
      .then((result) =>
        dispatch({ type: "detail_loaded", detail: result.issue, problems: result.problems }),
      )
      .catch((err: unknown) => setUpdateError(describeAgentError(err)))
      .finally(() => setUpdating(false));
  }, [id, current, updating, dispatch]);

  const status: IssueDetailStatus =
    phase === "missing" || phase === "error" ? phase : detail ? "ready" : "loading";

  return {
    detail,
    summary,
    status,
    error,
    problems: id ? selectProblemsForId(state, id) : [],
    retry,
    updating,
    updateError,
    toggleStatus,
  };
}
