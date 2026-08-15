/**
 * Pure state for the shared reports store — one reducer plus selectors, with
 * no React and no I/O, so every ordering and race rule below is unit-testable
 * on its own. `ReportsProvider` supplies the effects.
 */

import type { ReportStreamEvent, StreamStatus } from "./api";
import { toIssueSummary, type WireProblem } from "./reportWire";
import type { IssueDetail, IssueStatus, IssueSummary } from "./types";

export const PROBLEM_LIMIT = 20;

export interface ReportsState {
  /** Always sorted by `compareIssues`, always unique by id. */
  issues: IssueSummary[];
  details: Record<string, IssueDetail>;
  /** True only until the FIRST fetch settles — drives the one-time skeleton. */
  loading: boolean;
  /** A list fetch is in flight → stream events are buffered, not applied. */
  fetching: boolean;
  error: string | null;
  stream: StreamStatus;
  buffered: ReportStreamEvent[];
  /** Newest first, capped at PROBLEM_LIMIT. */
  problems: WireProblem[];
}

export type ReportsAction =
  | { type: "fetch_started" }
  | { type: "fetch_succeeded"; issues: IssueSummary[]; problems: WireProblem[] }
  | { type: "fetch_failed"; message: string }
  | { type: "stream_status"; status: StreamStatus }
  | { type: "stream_event"; event: ReportStreamEvent }
  | { type: "wire_problem"; problem: WireProblem }
  | { type: "detail_loaded"; detail: IssueDetail; problems: WireProblem[] };

export const initialReportsState: ReportsState = {
  issues: [],
  details: {},
  loading: true,
  fetching: false,
  error: null,
  stream: "connecting",
  buffered: [],
  problems: [],
};

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

/**
 * Replace-by-id or append, then re-sort. Every mutation of `issues` ends in a
 * sort: the previous `[event.issue, ...prev]` assumed any unknown id was the
 * newest report, so one `report_updated` for a report this client had never
 * loaded permanently corrupted "newest first" until remount.
 */
export function upsertSummary(list: IssueSummary[], next: IssueSummary): IssueSummary[] {
  const index = list.findIndex((issue) => issue.id === next.id);
  const copy = list.slice();
  if (index === -1) copy.push(next);
  else copy[index] = next;
  return copy.sort(compareIssues);
}

function capProblems(problems: WireProblem[]): WireProblem[] {
  return problems.slice(0, PROBLEM_LIMIT);
}

/** Writing BOTH sides is what makes an open detail page live-update for free. */
function applyEvent(state: ReportsState, event: ReportStreamEvent): ReportsState {
  return {
    ...state,
    details: { ...state.details, [event.issue.id]: event.issue },
    issues: upsertSummary(state.issues, toIssueSummary(event.issue)),
  };
}

export function reportsReducer(state: ReportsState, action: ReportsAction): ReportsState {
  switch (action.type) {
    case "fetch_started":
      // Does NOT clear `issues`: a refresh must not blank the grid.
      return { ...state, fetching: true };

    case "fetch_succeeded": {
      const base: ReportsState = {
        ...state,
        issues: action.issues.slice().sort(compareIssues),
        fetching: false,
        loading: false,
        error: null,
        problems: capProblems([
          ...action.problems,
          ...state.problems.filter((problem) => problem.source !== "list"),
        ]),
      };
      // Events that arrived while the snapshot was in flight are replayed on
      // top of it, in arrival order — otherwise a status change could be
      // silently reverted by an older server-side read.
      const replayed = state.buffered.reduce(applyEvent, base);
      return { ...replayed, buffered: [] };
    }

    case "fetch_failed": {
      const base: ReportsState = {
        ...state,
        fetching: false,
        loading: false,
        error: action.message,
      };
      // Buffered events are good data regardless of why the list fetch failed.
      const replayed = state.buffered.reduce(applyEvent, base);
      return { ...replayed, buffered: [] };
    }

    case "stream_event":
      if (state.fetching) {
        return { ...state, buffered: [...state.buffered, action.event] };
      }
      return applyEvent(state, action.event);

    case "stream_status":
      return { ...state, stream: action.status };

    case "wire_problem":
      return { ...state, problems: capProblems([action.problem, ...state.problems]) };

    case "detail_loaded":
      // Why resolving from the detail page moves the item between the Issues
      // tabs and updates the Dashboard counters with no refetch.
      return {
        ...state,
        details: { ...state.details, [action.detail.id]: action.detail },
        issues: upsertSummary(state.issues, toIssueSummary(action.detail)),
        problems: capProblems([...action.problems, ...state.problems]),
      };
  }
}

export function selectIssues(state: ReportsState, status: IssueStatus): IssueSummary[] {
  return state.issues.filter((issue) => issue.status === status);
}

export function selectCounts(state: ReportsState): { pending: number; resolved: number } {
  let pending = 0;
  let resolved = 0;
  for (const issue of state.issues) {
    if (issue.status === "resolved") resolved += 1;
    else pending += 1;
  }
  return { pending, resolved };
}

/**
 * Scoped on purpose: a global problem list rendered on the detail page would
 * put wire noise from unrelated reports directly above an incident report.
 */
export function selectProblemsForId(state: ReportsState, id: string): WireProblem[] {
  return state.problems.filter((problem) => problem.id === id);
}
