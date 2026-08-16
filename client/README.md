# IDAR — Web Panel

Web panel (React + TypeScript + Vite) for the _Agent-Based System for Supporting Incident
Diagnosis in Cloud-Native Infrastructures_.

## Features

- **Documentation** (main view) — add documents to the RAG knowledge base via _drag & drop_
  or a file picker. Supported formats:
  - **PDF** → converted to Markdown by the local **doc-converter** service (max 15 MB).
  - **Markdown / plain text** (`.md`, `.markdown`, `.mdx`, `.txt`) → no conversion (passthrough).
  - The converted Markdown is **editable by hand before sending** (Preview / Edit tabs) —
    useful when the converter flattens a code block, or a section simply is not wanted.
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
  issue opens `/issues/:id`: a single centred report page built from the agent's
  structured findings — the problem, the error sources it inspected, its suggested
  remediations, and the raw model diagnosis behind a collapsible disclosure — plus a
  "Mark resolved"/"Reopen" action and a "Copy Markdown" button that yields the agent's
  own Markdown rendering of the report.
- **Dashboard** — shortcuts and issue counts, also sourced live from `agent-core`.
- **Settings** — the default document author. Conversion and model settings belong to the
  `doc-converter` service, not to this panel.

## Getting started

```bash
npm install
npm run dev
```

The Issues and Dashboard views need `agent-core`'s webhook server running and reachable
(see `VITE_AGENT_API_URL` below) — without it they'll show a connection error rather than
data.

## Document converter

PDF conversion is done by [`doc-converter`](../doc-converter/README.md), a local service — no
API key lives in this app. Point the client at it:

```
VITE_CONVERTER_URL=http://localhost:5001
VITE_CONVERTER_TOKEN=<only if API_TOKEN is set on the service>
```

The sidebar shows whether the service has an optional vision model configured; clicking it
explains where that key goes (the service's own `.env`, never here).

## Diagnostic agent configuration

The Issues and Dashboard views read from `agent-core`'s webhook server. Add these to
`client/.env`:

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

React 19, React Router, TanStack Query, Tailwind CSS v4, react-dropzone,
react-markdown + remark-gfm, date-fns, lucide-react, vitest.

> Note: `VITE_*` variables are compiled into the public JS bundle, so anything set here is
> visible to every user of the browser app. No model key is configured client-side any more —
> that moved to the `doc-converter` service — but the service tokens, if set, still are. For a
> publicly hosted build they should move behind a proxy.
