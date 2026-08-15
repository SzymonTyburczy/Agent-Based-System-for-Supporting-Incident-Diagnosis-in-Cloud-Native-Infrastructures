import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { isNotFound } from "./api";
import { toIssueSummary } from "./reportWire";
import type { IssueDetail, IssueSummary } from "./types";

export const reportKeys = {
  all: ["reports"] as QueryKey,
  list: ["reports", "list"] as QueryKey,
  detail: (id: string) => ["reports", "detail", id] as QueryKey,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The SSE stream is this app's freshness mechanism, not polling: a
        // report only changes when the agent says so, and it says so on the
        // stream. Without this, every Dashboard↔Issues navigation would
        // refetch the whole list.
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        // A 404 is an answer, not a hiccup — retrying it three times (the
        // default) only delays the "not found" the user needs to see.
        retry: (failureCount, error) => !isNotFound(error) && failureCount < 1,
      },
    },
  });
}

/**
 * Newest first. Deliberately `Date.parse` rather than a string comparison: a
 * non-empty unparseable timestamp such as "not-a-date" sorts ABOVE every
 * valid ISO date lexicographically, which would pin a broken record to the
 * top of an incident list.
 */
export function compareIssues(a: IssueSummary, b: IssueSummary): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const na = Number.isNaN(ta);
  const nb = Number.isNaN(tb);
  if (na !== nb) return na ? 1 : -1;
  if (!na && ta !== tb) return tb - ta;
  return a.id.localeCompare(b.id);
}

/** Replace-by-id or append, then re-sort — never "prepend and hope": an
 * update for a report this client never loaded is not necessarily the newest. */
export function upsertSummary(list: IssueSummary[], next: IssueSummary): IssueSummary[] {
  const index = list.findIndex((issue) => issue.id === next.id);
  const copy = list.slice();
  if (index === -1) copy.push(next);
  else copy[index] = next;
  return copy.sort(compareIssues);
}

/**
 * Writes one report into both caches — the detail it is, and the list row it
 * implies. Used by the SSE stream and by the status mutation, which is why
 * resolving an issue from the detail page moves it between the Issues tabs
 * and updates the Dashboard counters with no refetch.
 */
export function cacheReport(client: QueryClient, report: IssueDetail): void {
  client.setQueryData(reportKeys.detail(report.id), report);
  client.setQueryData<IssueSummary[]>(reportKeys.list, (list) =>
    upsertSummary(list ?? [], toIssueSummary(report)),
  );

  // Cold-start race: a list fetch already in flight would land afterwards and
  // overwrite what we just wrote with a snapshot taken before it. Marking the
  // list stale makes it refetch once that one settles.
  if (client.isFetching({ queryKey: reportKeys.list }) > 0) {
    void client.invalidateQueries({ queryKey: reportKeys.list });
  }
}
