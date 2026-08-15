import { useQuery } from "@tanstack/react-query";
import { describeAgentError, fetchIssues } from "../lib/api";
import { compareIssues, reportKeys } from "../lib/reportsCache";
import type { IssueSummary } from "../lib/types";

export interface UseReportsResult {
  issues: IssueSummary[];
  pending: IssueSummary[];
  resolved: IssueSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The issues list. One query key for the whole app, so mounting this on the
 * Dashboard and on Issues costs one request, not two, and the data outlives
 * navigation.
 *
 * Deliberately unfiltered: the Dashboard needs both counts and IssuesPage's
 * tabs are a client-side split of the same list, so a server-side `?status=`
 * filter could never serve this call site.
 */
export function useReports(): UseReportsResult {
  const query = useQuery({
    queryKey: reportKeys.list,
    queryFn: ({ signal }) => fetchIssues(signal).then((issues) => issues.sort(compareIssues)),
  });

  const issues = query.data ?? [];

  return {
    issues,
    pending: issues.filter((issue) => issue.status === "pending"),
    resolved: issues.filter((issue) => issue.status === "resolved"),
    loading: query.isPending,
    error: query.error ? describeAgentError(query.error) : null,
    refresh: () => void query.refetch(),
  };
}
