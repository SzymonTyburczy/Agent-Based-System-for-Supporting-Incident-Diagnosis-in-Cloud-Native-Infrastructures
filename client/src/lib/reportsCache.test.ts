import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  cacheReport,
  compareIssues,
  createQueryClient,
  reportKeys,
  upsertSummary,
} from "./reportsCache";
import type { IssueDetail, IssueSummary } from "./types";

function summary(overrides: Partial<IssueSummary> & { id: string }): IssueSummary {
  return {
    title: "Checkout errors",
    service: "checkout",
    severity: "critical",
    status: "pending",
    createdAt: "2026-07-18T12:00:00Z",
    summary: "Payments are timing out.",
    ...overrides,
  };
}

describe("compareIssues", () => {
  it("sorts newest first and puts an unparseable timestamp LAST", () => {
    const sorted = [
      summary({ id: "old", createdAt: "2026-07-18T10:00:00Z" }),
      // A non-empty unparseable value: it sorts ABOVE every valid ISO date
      // under lexicographic comparison, which "" would not expose.
      summary({ id: "broken", createdAt: "not-a-date" }),
      summary({ id: "new", createdAt: "2026-07-18T18:00:00Z" }),
    ].sort(compareIssues);

    expect(sorted.map((issue) => issue.id)).toEqual(["new", "old", "broken"]);
  });
});

describe("upsertSummary", () => {
  it("inserts an unknown id at its date position, not at the top", () => {
    const list = [
      summary({ id: "newer", createdAt: "2026-07-18T18:00:00Z" }),
      summary({ id: "older", createdAt: "2026-07-18T09:00:00Z" }),
    ];

    const next = upsertSummary(list, summary({ id: "middle", createdAt: "2026-07-18T12:00:00Z" }));

    // Regression: a plain prepend assumed any unknown id was the newest report.
    expect(next.map((issue) => issue.id)).toEqual(["newer", "middle", "older"]);
  });

  it("replaces a known id in place without duplicating it", () => {
    const list = [summary({ id: "rep-1", status: "pending" })];

    const next = upsertSummary(list, summary({ id: "rep-1", status: "resolved" }));

    expect(next).toHaveLength(1);
    expect(next[0].status).toBe("resolved");
  });
});

describe("cacheReport", () => {
  const report: IssueDetail = {
    ...summary({ id: "rep-new", createdAt: "2026-07-18T18:00:00Z" }),
    problem: "The payment service is timing out.",
    errorSources: [],
    remediations: [],
    rawDiagnosis: "full free-text diagnosis",
    markdownExport: "# Checkout errors",
  };
  const stored = summary({ id: "rep-old", createdAt: "2026-07-18T09:00:00Z" });

  /** A mounted `useReports`, minus React: an active observer on the list. */
  function observeList(queryFn: () => Promise<IssueSummary[]>) {
    const client = createQueryClient();
    // No retry: the default's 1s backoff only slows the "first GET failed" setup.
    const observer = new QueryObserver(client, {
      queryKey: reportKeys.list,
      queryFn,
      retry: false,
    });
    observer.subscribe(() => {});
    return { client, observer };
  }

  it("upserts into a list that has loaded", () => {
    const client = createQueryClient();
    client.setQueryData(reportKeys.list, [stored]);

    cacheReport(client, report);

    expect(client.getQueryData(reportKeys.detail("rep-new"))).toBe(report);
    expect(client.getQueryData<IssueSummary[]>(reportKeys.list)?.map((i) => i.id)).toEqual([
      "rep-new",
      "rep-old",
    ]);
  });

  it("refetches a list whose first GET failed instead of seeding it with one report", async () => {
    const queryFn = vi
      .fn<() => Promise<IssueSummary[]>>()
      .mockRejectedValueOnce(new Error("agent down"))
      .mockResolvedValue([report, stored]);
    const { client, observer } = observeList(queryFn);
    await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe("error"));

    cacheReport(client, report);

    // Regression: the error became a confident `[report]` that
    // `staleTime: Infinity` never refetched — Dashboard read "Pending: 1".
    expect(client.getQueryData(reportKeys.list)).toBeUndefined();
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([report, stored]));
    expect(client.getQueryData(reportKeys.detail("rep-new"))).toBe(report);
  });

  it("does not let a first list fetch already in flight land a snapshot older than the report", async () => {
    let landFirst: (list: IssueSummary[]) => void = () => {};
    const queryFn = vi
      .fn<() => Promise<IssueSummary[]>>()
      .mockImplementationOnce(() => new Promise((resolve) => (landFirst = resolve)))
      .mockResolvedValue([report, stored]);
    const { client, observer } = observeList(queryFn);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    cacheReport(client, report);
    landFirst([stored]);

    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([report, stored]));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
