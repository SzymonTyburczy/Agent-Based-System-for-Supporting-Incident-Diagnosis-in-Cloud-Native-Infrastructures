import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { describeAgentError, fetchIssues, subscribeToReportEvents } from "../lib/api";
import { initialReportsState, reportsReducer } from "../lib/reportsState";
import { ReportsContext } from "../hooks/reportsContext";

/**
 * The app's single owner of report I/O: one `GET /reports`, one `EventSource`
 * and one reducer for the whole session, mounted once in `Layout`.
 *
 * Before this, Dashboard and Issues each ran their own copy of `useReports`,
 * so navigating between them refetched the list and tore down/reopened the
 * stream every time (twice over, under StrictMode).
 */
export function ReportsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reportsReducer, initialReportsState);
  const abortRef = useRef<AbortController | null>(null);
  const openedOnce = useRef(false);

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "fetch_started" });

    fetchIssues({ signal: controller.signal })
      .then((result) =>
        dispatch({ type: "fetch_succeeded", issues: result.issues, problems: result.problems }),
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: "fetch_failed", message: describeAgentError(err) });
      });
  }, []);

  useEffect(() => {
    // Independent of the stream, so a dead agent surfaces an error even when
    // the SSE connection never opens at all.
    refresh();

    const unsubscribe = subscribeToReportEvents({
      onEvent: (event) => dispatch({ type: "stream_event", event }),
      onProblem: (problem) => {
        // Logging lives here rather than in `lib` so the pure decoders stay
        // pure and their tests don't spam stderr.
        console.warn("[idar/wire]", problem);
        dispatch({ type: "wire_problem", problem });
      },
      onStatus: (status) => {
        dispatch({ type: "stream_status", status });
        if (status !== "live") return;
        // Resync after a reconnect. Not polish: ReportEventBroadcaster.publish
        // drops a subscriber's OLDEST pending event once its 32-slot queue is
        // full, so a briefly-disconnected client provably misses updates that
        // only a refetch repairs.
        if (openedOnce.current) refresh();
        openedOnce.current = true;
      },
    });

    return () => {
      unsubscribe();
      abortRef.current?.abort();
    };
  }, [refresh]);

  const value = useMemo(() => ({ state, dispatch, refresh }), [state, refresh]);

  return <ReportsContext.Provider value={value}>{children}</ReportsContext.Provider>;
}
