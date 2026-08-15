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
  API and kept in sync over SSE (`useReports`). An issue opens `/issues/:id`: Markdown
  diagnostic report on the left, a "Mark resolved"/"Reopen" action (`PATCH /reports/{id}`),
  and an AI chat panel on the right (chat is local-state only — data flow to be wired
  later).
- **Dashboard** — issue counts from the same live `useReports` data; the document count
  is still a placeholder (no RAG backend yet).
- **Settings** — Gemini model, default author; the API key comes only from
  `VITE_GEMINI_API_KEY` in `client/.env` — it is not configurable from the UI.

Conventions:

- `src/lib/` — pure logic (api, converter, models, settings, types, format); vitest tests
  live alongside the tested module (`api.test.ts`, `converter.test.ts`).
- `src/lib/api.ts` — the only place that talks to `agent-core`; wire shapes
  (`RawReport*`) are mapped to the app's own `Issue` types there, never used raw.
- `src/hooks/` — shared hooks (`useReports`, `useDocDraft`, `useTransientFlag`).
- Shared `.card` / `.input` CSS component classes live in `src/index.css`.
- Named exports everywhere (no default exports).
- `client/.env` is tracked with an empty key as a template — never commit a real key;
  after pasting one locally run `git update-index --skip-worktree client/.env`.

Checks: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`.
