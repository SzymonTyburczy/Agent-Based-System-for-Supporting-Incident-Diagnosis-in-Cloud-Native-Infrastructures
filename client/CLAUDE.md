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
- **Issues** — split into pending and resolved (mock data).
- **Dashboard** and **Settings** (Gemini model, default author; the API key comes only
  from `VITE_GEMINI_API_KEY` in `client/.env` — it is not configurable from the UI).

Conventions:

- `src/lib/` — pure logic (converter, models, settings, types) with vitest tests alongside.
- `src/hooks/` — shared hooks (`useDocDraft`, `useTransientFlag`).
- Shared `.card` / `.input` CSS component classes live in `src/index.css`.
- Named exports everywhere (no default exports).
- `client/.env` is tracked with an empty key as a template — never commit a real key;
  after pasting one locally run `git update-index --skip-worktree client/.env`.

Checks: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`.
