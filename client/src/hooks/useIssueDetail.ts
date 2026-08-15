import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeAgentError, fetchIssue, isNotFound, updateIssueStatus } from "../lib/api";
import { cacheReport, reportKeys } from "../lib/reportsCache";
import type { IssueDetail, IssueSummary } from "../lib/types";
import { useReports } from "./useReports";

export type IssueDetailStatus = "loading" | "ready" | "missing" | "error";

export interface UseIssueDetailResult {
  detail: IssueDetail | null;
  /** Cached from the list → the header paints instantly on a list→detail click. */
  summary: IssueSummary | null;
  status: IssueDetailStatus;
  error: string | null;
  retry: () => void;
  updating: boolean;
  updateError: string | null;
  toggleStatus: () => void;
}

export function useIssueDetail(id: string | undefined): UseIssueDetailResult {
  const client = useQueryClient();
  const { issues } = useReports();
  const summary = id ? (issues.find((issue) => issue.id === id) ?? null) : null;

  const query = useQuery({
    queryKey: reportKeys.detail(id ?? ""),
    queryFn: ({ signal }) => fetchIssue(id as string, signal),
    enabled: Boolean(id),
  });

  const mutation = useMutation({
    mutationFn: (next: IssueDetail["status"]) => updateIssueStatus(id as string, next),
    // The PATCH response is authoritative; a read still in flight carries the
    // pre-write state and would otherwise land last and revert the toggle.
    onMutate: () => client.cancelQueries({ queryKey: reportKeys.detail(id ?? "") }),
    // Not optimistic: the server echoes the full detail and its own
    // `report_updated` follows moments later. Briefly showing an incident as
    // resolved when the write failed is a worse lie than 200ms of "Updating…".
    onSuccess: (report) => cacheReport(client, report),
  });

  const detail = query.data ?? null;
  const current = detail ?? summary;

  let status: IssueDetailStatus;
  if (!id || isNotFound(query.error)) status = "missing";
  else if (query.error && !detail) status = "error";
  else status = detail ? "ready" : "loading";

  return {
    detail,
    summary,
    status,
    error: query.error ? describeAgentError(query.error) : null,
    retry: () => void query.refetch(),
    updating: mutation.isPending,
    updateError: mutation.error ? describeAgentError(mutation.error) : null,
    toggleStatus: () => {
      if (!current || mutation.isPending) return;
      mutation.mutate(current.status === "pending" ? "resolved" : "pending");
    },
  };
}
