import { describe, expect, it } from "vitest";
import { compareIssues, upsertSummary } from "./reportsCache";
import type { IssueSummary } from "./types";

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
