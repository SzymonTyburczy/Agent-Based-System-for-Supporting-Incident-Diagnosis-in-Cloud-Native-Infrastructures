import type { StreamStatus } from "../lib/api";
import type { WireProblem } from "../lib/reportWire";
import { selectIssues } from "../lib/reportsState";
import type { IssueSummary } from "../lib/types";
import { useReportsStore } from "./reportsContext";

export interface UseReportsResult {
  issues: IssueSummary[];
  pending: IssueSummary[];
  resolved: IssueSummary[];
  loading: boolean;
  error: string | null;
  stream: StreamStatus;
  problems: WireProblem[];
  refresh: () => void;
}

/**
 * A thin read over the shared store in `ReportsProvider` — no fetch, no
 * subscription, no local state, so mounting this in several places costs
 * nothing and the data outlives navigation.
 *
 * The underlying list is deliberately unfiltered: the Dashboard needs both
 * counts and IssuesPage's tabs are a client-side split of the same list, so a
 * server-side `?status=` filter could never serve this call site.
 */
export function useReports(): UseReportsResult {
  const { state, refresh } = useReportsStore();

  return {
    issues: state.issues,
    pending: selectIssues(state, "pending"),
    resolved: selectIssues(state, "resolved"),
    loading: state.loading,
    error: state.error,
    stream: state.stream,
    problems: state.problems,
    refresh,
  };
}
