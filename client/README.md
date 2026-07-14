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
  - A draft (file, content, metadata) is persisted in `localStorage`, so a page refresh
    does not lose your work.
- **Issues** — preview of incidents split into _pending_ and _resolved_ (mock data for now).
- **Dashboard** — shortcuts and basic statistics.
- **Settings** — Gemini model selection and the default document author. The API key is
  configured exclusively via `.env` (see below), not from the UI.

## Getting started

```bash
npm install
npm run dev
```

## Gemini configuration

PDF conversion requires a Google Gemini API key. The repository ships `client/.env` with an
empty value — paste your key there and restart the dev server:

```
VITE_GEMINI_API_KEY=<your key>
```

Get a key in [Google AI Studio](https://aistudio.google.com/apikey) (free tier, no GCP needed).

> **Never commit your key.** `client/.env` is tracked with an empty value as a template.
> After pasting your key, tell git to ignore your local changes:
>
> ```bash
> git update-index --skip-worktree client/.env
> ```

## Scripts

| Command                 | Description                            |
| ----------------------- | -------------------------------------- |
| `npm run dev`           | start the Vite dev server              |
| `npm run build`         | typecheck + production build           |
| `npm test`              | run unit tests (vitest)                |
| `npm run lint`          | lint with oxlint                       |
| `npm run format`        | format with Prettier                   |
| `npm run typecheck`     | TypeScript check without emitting      |

## Stack

React 19, React Router, Tailwind CSS v4, react-dropzone, react-markdown + remark-gfm,
`@google/genai`, date-fns, lucide-react, vitest.

> Note: `VITE_*` variables are compiled into the public JS bundle — the key is visible to
> every user of the browser app. That is acceptable for a local development tool, but such
> a build **must not be hosted publicly**. In production the conversion should move behind
> a backend/proxy so the key is never exposed.
