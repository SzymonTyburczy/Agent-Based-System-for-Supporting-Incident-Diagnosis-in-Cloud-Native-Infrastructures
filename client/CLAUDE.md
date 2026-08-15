# CLAUDE.md — Frontend

Web panel (React 19 + TypeScript strict + Vite + Tailwind v4) for the incident-diagnosis
system in cloud-native infrastructures (IDAR).

Main views:

- **Documentation** — add documents (drag & drop / file picker, max 15 MB) to the RAG
  knowledge base; PDF is converted to Markdown via Google Gemini, Markdown/text passes
  through unchanged. The result is packed as JSON `{ data, autor, tresc }` (field names
  are Polish per the agreed backend contract; `data` is a day-precision date, yyyy-MM-dd).
  Send currently logs the payload to the console and clears the form — no backend yet.
  The in-progress draft is persisted to localStorage.
- **Issues** — split into pending and resolved, loaded from `agent-core`'s `/reports*`
  API and kept in sync over SSE. One shared store (`ReportsProvider`, mounted in `Layout`)
  serves the Issues, Dashboard and detail views: a single `GET /reports` and a single
  `EventSource` for the app's lifetime. An issue opens `/issues/:id` — a single centred
  document built from the report's structured fields (`problem`, `error_sources`,
  `remediations`, `raw_diagnosis`), with a "Mark resolved"/"Reopen" action
  (`PATCH /reports/{id}`) and a "Copy Markdown" button.
- **Dashboard** — issue counts from the same live `useReports` data; the document count
  is still a placeholder (no RAG backend yet).
- **Settings** — Gemini model, default author; the API key comes only from
  `VITE_GEMINI_API_KEY` in `client/.env` — it is not configurable from the UI.

Conventions:

- `src/lib/` — pure logic (api, reportWire, reportsState, issueView, converter, models,
  settings, types, format); vitest tests live alongside the tested module.
- `src/lib/api.ts` — the only place that talks to `agent-core`. Its `request()` returns
  `unknown` on purpose: `src/lib/reportWire.ts` is the single decode boundary where wire
  JSON becomes `IssueSummary` / `IssueDetail`, and both the REST and the SSE path go
  through it.
- `src/hooks/` — shared hooks (`useReports`, `useIssueDetail`, `useDocDraft`,
  `useTransientFlag`) plus `reportsContext`.
- Shared `.card` / `.input` CSS component classes live in `src/index.css`.
- Named exports everywhere (no default exports).
- `client/.env` is tracked with an empty key as a template — never commit a real key;
  after pasting one locally run `git update-index --skip-worktree client/.env`.

Report rendering — standing rules:

- `content_md` is an **export artifact only** — surfaced as `IssueDetail.markdownExport`
  and used solely as the "Copy Markdown" payload. It is never parsed or rendered. If
  `agent_core/report.py::render_report_markdown` gains a section, the corresponding
  structured field must be added to `IssueDetail` and to the detail page — the UI will
  not pick it up for free.
- `raw_diagnosis` (and `problem` when the structuring step fell back, i.e.
  `problem === raw_diagnosis`) is rendered as a text node inside
  `<pre className="whitespace-pre-wrap [font-family:inherit]">`, never through
  react-markdown. CommonMark collapses its newlines, renumbers its list markers, turns
  4-space indents into code blocks, and lets one unbalanced fence swallow the rest.
- `error_sources` and `remediations` are rendered as plain text nodes — they are
  PromQL/LogQL fragments and pod names that Markdown would italicise on underscores.
- Never add `rehype-raw` and never `dangerouslySetInnerHTML` to any of these five fields.
  react-markdown v10 escapes HTML by default and its `urlTransform` neutralises
  `javascript:`/`data:` hrefs — keep it that way.
- `<main>` in `Layout` is the app's only vertical scroll container. Pages must not add
  nested `overflow-y-auto` regions (the sole exception is the raw-diagnosis `<details>`,
  which is a disclosure, not a scroll region).
- The AI chat panel was removed deliberately and is postponed to the end of the project.
  When it returns it will be the first always-mounted second consumer of the reports
  store, which is what the `ReportsProvider` context already exists to serve.

Checks: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`.
