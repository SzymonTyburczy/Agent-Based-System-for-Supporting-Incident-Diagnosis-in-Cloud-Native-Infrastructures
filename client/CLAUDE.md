# CLAUDE.md — Frontend

Web panel (React 19 + TypeScript strict + Vite + Tailwind v4) for the incident-diagnosis
system in cloud-native infrastructures (IDAR).

Main views:

- **Documentation** — add documents (drag & drop / file picker, max 15 MB) to the RAG
  knowledge base; PDF is converted to Markdown by the local `doc-converter` service,
  Markdown/text passes through unchanged. The converted Markdown is editable in place
  (Preview / Edit tabs) and the edit is what ends up in the payload. The result is packed as JSON `{ data, autor, tresc }` (field names
  are Polish per the agreed backend contract; `data` is a day-precision date, yyyy-MM-dd),
  plus the optional `nazwa_pliku` — the uploaded file's name — when there is one.
  Send posts it to the RAG knowledge base (`server/`, `POST /api/documents`) and clears
  the form; the confirmation distinguishes a fresh ingest from a document the server
  already had (`already_exists` — document ids are a hash of `tresc`). A failure keeps
  the draft on screen, because converting and hand-editing a document is the expensive
  part; for the same reason the form is locked while Send is in flight, so the reset
  after success never wipes an edit made meanwhile. The in-progress draft is persisted
  to localStorage. A successful ingest invalidates the cached knowledge-base documents.
- **Knowledge base** — `/knowledge-base`: the documents in the RAG knowledge base
  (`GET /api/documents`, metadata only), filtered client-side by file name / title
  (`filterDocuments`: case- and diacritics-insensitive, every word must match). Selecting
  one sets `?doc=<id>` and opens `DocumentViewer` beside the list with the full Markdown
  (`GET /api/documents/{id}`); a document ingested before the server kept originals is
  marked "reconstructed". Each row has a Delete (`window.confirm`, then
  `DELETE /api/documents/{id}`), which also closes the viewer if it showed that document.
- **Issues** — split into pending and resolved, loaded from `agent-core`'s `/reports*`
  API and kept in sync over SSE. TanStack Query owns the cache: one `GET /reports` for the
  app's lifetime (`staleTime: Infinity` — the SSE stream is the freshness mechanism, not
  polling), and `ReportsStream` feeds every event straight into it. An issue opens
  `/issues/:id` — a single centred
  document built from the report's structured fields (`problem`, `error_sources`,
  `remediations`, `raw_diagnosis`), with a "Mark resolved"/"Reopen" action
  (`PATCH /reports/{id}`) and a "Copy Markdown" button. The report's `citations` (resolved
  by agent-core from the `[KBn]` keys it handed the model) become a "Documentation
  sources" card plus numbered chips where the text cites them; a chip opens the cited
  document in `DocumentViewer` beside the report, scrolled to and highlighting the
  passage (fallback: the section heading, then the top with a note). The panel lives in
  the URL — `?doc=<docId>&cite=<KBn>` (no `cite` for a whole-document citation), pushed
  on the first open and replaced while open, so Back closes it (`useDocumentPanel`).
  Opening moves focus to the panel's heading, and closing hands it back to the chip or
  row that opened it when the panel's unmount would otherwise drop it on `<body>`.
- **Dashboard** — issue counts from the same live `useReports` data.
- **Settings** — default document author only. No model key is configurable from this app:
  the converter owns its own model configuration (`doc-converter/.env`). The sidebar reports
  what the service says about itself via its `/healthz`, and the dialog explains where the key
  goes — it never accepts one.

Conventions:

- `src/lib/` — pure logic (api, reportWire, reportsCache, issueView, converter,
  knowledgeBase, documentsCache, documentSearch, citations, fragment, markdownLines,
  layout, settings, types, format); vitest tests live alongside the tested module.
- Component tests (`src/components/*.test.tsx`) render with `react-dom/server`'s
  `renderToStaticMarkup`: vitest runs in node with no DOM, so they pin the markup a
  component produces (highlights, chips, notes), not interaction.
- `src/lib/api.ts` — the only place that talks to `agent-core`. Its `request()` returns
  `unknown` on purpose: `src/lib/reportWire.ts` is the single decode boundary where wire
  JSON becomes `IssueSummary` / `IssueDetail`, and both the REST and the SSE path go
  through it.
- `src/lib/knowledgeBase.ts` — the only place that talks to the RAG server (ingest, list,
  get, delete). It validates the wire shape before returning and turns every failure into
  a `KnowledgeBaseError` carrying the server's own `detail` message, so the page renders
  that rather than a status code. Its documents are cached under `documentKeys`
  (`src/lib/documentsCache.ts`) with a finite `staleTime` — nothing pushes knowledge-base
  changes the way SSE pushes reports — and read through `useDocuments` / `useDocument` /
  `useDeleteDocument`.
- `src/lib/reportsCache.ts` — the query keys, the `QueryClient` defaults, and
  `cacheReport()`, which writes one report into both the detail and the list cache. Any
  new consumer of report data reads through `useReports` / `useIssueDetail`, not `fetch`.
- `src/hooks/` — shared hooks (`useReports`, `useIssueDetail`, `useDocDraft`,
  `useTransientFlag`, `useConverterHealth`, `useDocuments`, `useDocumentPanel`) plus
  `streamContext`.
- Shared `.card` / `.input` / `.btn-secondary` CSS component classes live in
  `src/index.css`; shared `EmptyCard` / `ErrorCard` / `StaleBanner` / `IssueMeta` live in
  `src/components/Cards.tsx`. Use them rather than re-pasting the Tailwind string.
- Named exports everywhere (no default exports).
- `client/.env` is tracked with an empty key as a template — never commit a real key;
  after pasting one locally run `git update-index --skip-worktree client/.env`.
- Its base URLs are relative `/api/*` paths, routed by the dev proxy in `vite.config.ts`
  under `npm run dev`. A Docker image never sees `client/.env` (dockerignored) and takes
  its URLs from build args, absolute by default; `nginx.conf` serves the same `/api/*`
  routes, used only by an image built with `--build-arg VITE_*_URL=/api/...`. Keep the
  two route lists in sync.

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
- Citation chips never change how a field is rendered. In the text-node fields (error
  sources, remediations, raw text) `CitedText` splits the string with
  `splitCitationTokens` and the runs stay text nodes; only the Markdown `problem` goes
  through `linkifyCitations` (`[KB1]` → `[1](#cite-KB1)`), which `MarkdownPreview`'s
  `onCite` turns back into a chip. A marker naming no key the report lists stays
  plain text. Chip numbers are positions in `citations` (`citationLabel`), so the inline
  chips and the Sources card agree.
- Knowledge-base Markdown is rendered with `source="knowledge-base"`, which neutralises
  images (it may come from a third-party PDF). The viewer highlights by remark offsets
  (`highlight`, from `locateFragment` / `findSectionHeading`), so the `content` string
  must reach `MarkdownPreview` unmodified — any rewrite moves the highlight.
- `<main>` in `Layout` is the app's only vertical scroll container, with three deliberate
  exceptions: the Documentation preview/editor panel, which is height-bounded by
  `lg:h-full` so the upload form beside it stays put, the raw-diagnosis `<details>`,
  which is a disclosure rather than a scroll region, and `DocumentViewer`, which
  scrolls to the cited passage inside itself (viewport-tall and sticky at `xl`) without
  moving the report beside it. `Layout` drops its `max-w-6xl` where the viewer sits
  beside the content (`isWideRoute`).
- The AI chat panel was removed deliberately and is postponed to the end of the project.

Checks: `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check`.
