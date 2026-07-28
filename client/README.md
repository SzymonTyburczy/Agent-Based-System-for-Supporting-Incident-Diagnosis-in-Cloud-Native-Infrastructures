# IDAR — Web Panel

Web panel (React + TypeScript + Vite) for the _Agent-Based System for Supporting Incident
Diagnosis in Cloud-Native Infrastructures_.

## Features

- **Documentation** (main view) — add documents to the RAG knowledge base via _drag & drop_
  or a file picker. Supported formats:
  - **PDF** → automatically converted to Markdown with **Google Gemini** (max 15 MB).
  - **Markdown / plain text** (`.md`, `.markdown`, `.mdx`, `.txt`) → no conversion (passthrough).
  - After processing, a JSON payload is built for submission:
    ```json
    { "data": "<date yyyy-MM-dd>", "autor": "<author>", "tresc": "<markdown>" }
    ```
  - **Send** logs the payload to the browser console and clears the form — the backend
    endpoint is not wired up yet.
  - A draft (file name, converted content, metadata) is persisted in `localStorage`, so a
    page refresh does not lose your work.
- **Issues** — incidents split into _pending_ and _resolved_, loaded from the diagnostic
  agent (`agent-core`) via its REST API and kept in sync live over Server-Sent Events — a
  new investigation or a status change appears without refreshing the page. Clicking an
  issue opens `/issues/:id` with the Markdown diagnostic report on the left, a "Mark
  resolved"/"Reopen" action, and an AI chat panel on the right (chat is still local-state
  only — RAG-backed chat wiring pending).
- **Dashboard** — shortcuts and basic statistics, also sourced live from `agent-core`.
- **Settings** — Gemini model selection and the default document author. The API key is
  configured exclusively via `.env` (see below), not from the UI.

## Getting started

```bash
npm install
npm run dev
```

The Issues and Dashboard views need `agent-core`'s webhook server running and reachable
(see `VITE_AGENT_API_URL` below) — without it they'll show a connection error rather than
data.

## Gemini configuration

PDF conversion requires a Google Gemini API key. The repository ships `client/.env` with an
empty value — paste your key there and restart the dev server:

```
VITE_GEMINI_API_KEY=<your key>
```

Get a key in [Google AI Studio](https://aistudio.google.com/apikey) (free tier, no GCP needed).

## Diagnostic agent configuration

The Issues and Dashboard views read from `agent-core`'s webhook server. Add these to
`client/.env` alongside the Gemini key:

```
VITE_AGENT_API_URL=http://localhost:8090
VITE_AGENT_API_TOKEN=<only if agent-core was started with CLIENT_API_TOKEN set>
```

> **Never commit real values.** `client/.env` is tracked with empty placeholders as a
> template. After pasting your own keys, tell git to ignore your local changes:
>
> ```bash
> git update-index --skip-worktree client/.env
> ```

## Scripts

| Command             | Description                       |
| ------------------- | --------------------------------- |
| `npm run dev`       | start the Vite dev server         |
| `npm run build`     | typecheck + production build      |
| `npm test`          | run unit tests (vitest)           |
| `npm run lint`      | lint with oxlint                  |
| `npm run format`    | format with Prettier              |
| `npm run typecheck` | TypeScript check without emitting |

## Stack

React 19, React Router, Tailwind CSS v4, react-dropzone, react-markdown + remark-gfm,
`@google/genai`, date-fns, lucide-react, vitest.

> Note: `VITE_*` variables are compiled into the public JS bundle — every key here (Gemini,
> and the agent API token if set) is visible to every user of the browser app. That's
> acceptable for a local development tool, but such a build **must not be hosted publicly**.
> In production, both the Gemini conversion and the agent API calls should move behind a
> backend/proxy so no key is ever exposed client-side.
