import { useEffect, useState } from "react";
import { fetchIssues, subscribeToReportEvents } from "../lib/api";
import type { IssueSummary } from "../lib/types";

interface UseReportsResult {
  issues: IssueSummary[];
  loading: boolean;
  error: string | null;
}

/**
 * Loads all issues once via GET /reports, then keeps them in sync with
 * agent-core's SSE stream (new investigations, status changes from any
 * client) for as long as the component using this hook stays mounted.
 * Deliberately unfiltered — the dashboard needs both pending and resolved
 * counts, and IssuesPage's tabs are a client-side split of the same list,
 * mirroring how the old mock data was consumed.
 */
export function useReports(): UseReportsResult {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchIssues()
      .then((fetched) => {
        if (cancelled) return;
        setIssues(fetched);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const unsubscribe = subscribeToReportEvents((event) => {
      setIssues((prev) => {
        const index = prev.findIndex((issue) => issue.id === event.issue.id);
        if (index === -1) return [event.issue, ...prev];
        const next = [...prev];
        next[index] = event.issue;
        return next;
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { issues, loading, error };
}
