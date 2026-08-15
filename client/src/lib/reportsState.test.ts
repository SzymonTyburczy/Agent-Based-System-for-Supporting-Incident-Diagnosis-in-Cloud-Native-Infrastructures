import { describe, expect, it } from "vitest";
import type { ReportStreamEvent } from "./api";
import type { WireProblem } from "./reportWire";
import {
  initialReportsState,
  PROBLEM_LIMIT,
  reportsReducer,
  selectCounts,
  selectIssues,
  selectProblemsForId,
  type ReportsState,
} from "./reportsState";
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

function detail(overrides: Partial<IssueDetail> & { id: string }): IssueDetail {
  return {
    ...summary(overrides),
    problem: "Payment timeouts.",
    errorSources: ["checkout pod logs"],
    remediations: ["Scale payments"],
    rawDiagnosis: "raw",
    markdownExport: "# Checkout errors",
    ...overrides,
  };
}

function streamEvent(issue: IssueDetail): ReportStreamEvent {
  return { kind: "report_updated", issue };
}

function problem(overrides: Partial<WireProblem> = {}): WireProblem {
  return { source: "stream", kind: "dropped", id: null, reason: "boom", ...overrides };
}

describe("fetch_succeeded", () => {
  it("sorts newest-first and puts an unparseable timestamp LAST", () => {
    const state = reportsReducer(initialReportsState, {
      type: "fetch_succeeded",
      issues: [
        summary({ id: "old", createdAt: "2026-07-18T10:00:00Z" }),
        // A non-empty unparseable value: it sorts ABOVE every valid ISO date
        // under lexicographic comparison, which "" would not expose.
        summary({ id: "broken", createdAt: "not-a-date" }),
        summary({ id: "new", createdAt: "2026-07-18T18:00:00Z" }),
      ],
      problems: [],
    });

    expect(state.issues.map((issue) => issue.id)).toEqual(["new", "old", "broken"]);
    expect(state.loading).toBe(false);
    expect(state.fetching).toBe(false);
  });

  it("clears a previous error and supersedes every earlier drop, keeping repairs", () => {
    const seeded: ReportsState = {
      ...initialReportsState,
      error: "old failure",
      problems: [
        problem({ source: "list", reason: "stale" }),
        // Must not survive: IssuesPage counts it, and its own Reload button
        // would otherwise never be able to clear the banner.
        problem({ source: "stream", kind: "dropped", reason: "bad frame" }),
        problem({ source: "detail", kind: "repaired", id: "rep-1", reason: "defaulted `title`" }),
      ],
    };

    const state = reportsReducer(seeded, { type: "fetch_succeeded", issues: [], problems: [] });

    expect(state.error).toBeNull();
    expect(state.problems).toHaveLength(1);
    expect(state.problems[0]).toMatchObject({ source: "detail", kind: "repaired" });
  });

  it("repairs an already-cached detail from the fresh snapshot", () => {
    const seeded: ReportsState = {
      ...initialReportsState,
      issues: [summary({ id: "rep-1", status: "pending" })],
      details: { "rep-1": detail({ id: "rep-1", status: "pending" }) },
    };

    // The resync after a reconnect: the snapshot knows about a status change
    // whose SSE event the broadcaster dropped.
    const state = reportsReducer(seeded, {
      type: "fetch_succeeded",
      issues: [summary({ id: "rep-1", status: "resolved" })],
      problems: [],
    });

    expect(state.details["rep-1"].status).toBe("resolved");
    // …without discarding the narrative fields GET /reports does not carry.
    expect(state.details["rep-1"].markdownExport).toBe("# Checkout errors");
    expect(state.details["rep-1"].errorSources).toEqual(["checkout pod logs"]);
  });

  it("does not invent a detail for a report that was never opened", () => {
    const state = reportsReducer(initialReportsState, {
      type: "fetch_succeeded",
      issues: [summary({ id: "rep-1" })],
      problems: [],
    });

    expect(state.details).toEqual({});
  });
});

describe("the fetch-vs-stream race", () => {
  it("replays events buffered during a fetch on top of the snapshot", () => {
    let state = reportsReducer(initialReportsState, { type: "fetch_started" });
    state = reportsReducer(state, {
      type: "stream_event",
      event: streamEvent(detail({ id: "rep-1", status: "resolved" })),
    });

    // The event is held, not applied, while the snapshot is in flight.
    expect(state.buffered).toHaveLength(1);
    expect(state.issues).toHaveLength(0);

    // …and the snapshot itself is older: it still says pending.
    state = reportsReducer(state, {
      type: "fetch_succeeded",
      issues: [summary({ id: "rep-1", status: "pending" })],
      problems: [],
    });

    expect(state.issues[0].status).toBe("resolved");
    expect(state.buffered).toEqual([]);
    expect(state.fetching).toBe(false);
  });

  it("still replays buffered events when the fetch fails", () => {
    let state: ReportsState = {
      ...initialReportsState,
      issues: [summary({ id: "existing" })],
    };
    state = reportsReducer(state, { type: "fetch_started" });
    state = reportsReducer(state, {
      type: "stream_event",
      event: streamEvent(detail({ id: "rep-9", createdAt: "2026-07-19T10:00:00Z" })),
    });
    state = reportsReducer(state, { type: "fetch_failed", message: "agent unreachable" });

    expect(state.error).toBe("agent unreachable");
    expect(state.loading).toBe(false);
    expect(state.fetching).toBe(false);
    expect(state.issues.map((issue) => issue.id)).toEqual(["rep-9", "existing"]);
    expect(state.buffered).toEqual([]);
  });
});

describe("stream_event", () => {
  it("inserts an unknown id at its date position, not at the top", () => {
    const seeded: ReportsState = {
      ...initialReportsState,
      issues: [
        summary({ id: "newer", createdAt: "2026-07-18T18:00:00Z" }),
        summary({ id: "older", createdAt: "2026-07-18T09:00:00Z" }),
      ],
    };

    const state = reportsReducer(seeded, {
      type: "stream_event",
      event: streamEvent(detail({ id: "middle", createdAt: "2026-07-18T12:00:00Z" })),
    });

    // Regression: [event.issue, ...prev] pinned any unknown id to index 0.
    expect(state.issues.map((issue) => issue.id)).toEqual(["newer", "middle", "older"]);
  });

  it("replaces a known id in place and stores the full detail", () => {
    const seeded: ReportsState = {
      ...initialReportsState,
      issues: [summary({ id: "rep-1", status: "pending" })],
    };

    const state = reportsReducer(seeded, {
      type: "stream_event",
      event: streamEvent(detail({ id: "rep-1", status: "resolved" })),
    });

    expect(state.issues).toHaveLength(1);
    expect(state.issues[0].status).toBe("resolved");
    // Proves the detail payload the server already sends is no longer discarded.
    expect(state.details["rep-1"].markdownExport).toBe("# Checkout errors");
    expect(state.details["rep-1"].errorSources).toEqual(["checkout pod logs"]);
  });
});

describe("detail_loaded", () => {
  it("upserts both the detail and its summary, so counts move with no refetch", () => {
    const seeded: ReportsState = {
      ...initialReportsState,
      issues: [summary({ id: "rep-1", status: "pending" })],
    };

    const state = reportsReducer(seeded, {
      type: "detail_loaded",
      detail: detail({ id: "rep-1", status: "resolved" }),
      problems: [],
    });

    expect(selectCounts(state)).toEqual({ pending: 0, resolved: 1 });
    expect(state.details["rep-1"].status).toBe("resolved");
  });
});

describe("wire_problem", () => {
  it("appends newest-first and evicts the oldest past the cap", () => {
    let state = initialReportsState;
    for (let index = 0; index < PROBLEM_LIMIT + 5; index++) {
      state = reportsReducer(state, {
        type: "wire_problem",
        problem: problem({ reason: `problem-${index}` }),
      });
    }

    expect(state.problems).toHaveLength(PROBLEM_LIMIT);
    expect(state.problems[0].reason).toBe(`problem-${PROBLEM_LIMIT + 4}`);
  });
});

describe("selectors", () => {
  it("split by status, count, and scope problems to one id", () => {
    const state: ReportsState = {
      ...initialReportsState,
      issues: [summary({ id: "a" }), summary({ id: "b", status: "resolved" })],
      problems: [problem({ id: "a", reason: "mine" }), problem({ id: "b", reason: "theirs" })],
    };

    expect(selectIssues(state, "resolved").map((issue) => issue.id)).toEqual(["b"]);
    expect(selectCounts(state)).toEqual({ pending: 1, resolved: 1 });
    expect(selectProblemsForId(state, "a").map((p) => p.reason)).toEqual(["mine"]);
  });

  it("is stable on the initial state", () => {
    expect(selectIssues(initialReportsState, "pending")).toEqual([]);
    expect(selectCounts(initialReportsState)).toEqual({ pending: 0, resolved: 0 });
    expect(selectProblemsForId(initialReportsState, "any")).toEqual([]);
  });
});
