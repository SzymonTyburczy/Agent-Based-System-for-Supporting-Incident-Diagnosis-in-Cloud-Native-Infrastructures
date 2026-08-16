# doc-converter

Converts uploaded PDFs to Markdown for the RAG knowledge base. Runs locally —
no API key, no document leaves the machine.

Replaces the previous browser-side Google Gemini call, which compiled
`VITE_GEMINI_API_KEY` into the public JS bundle and sent internal runbooks to a
third party.

## Engine

[Docling](https://github.com/docling-project/docling) (MIT, IBM Research → LF AI
& Data). Its models are small local vision models for page layout and table
structure — not LLMs — so conversion needs no key and no network.

Measured on a runbook with an escalation table and a PromQL block:

| | ATX headings | GFM table |
|---|---|---|
| Docling | 6 | 4 columns, cell-perfect |
| MarkItDown | 0 | scattered into loose lines |

MarkItDown's PDF converter has no code path that can emit a heading or a code
fence, so an LLM key would not have closed the gap.

## Run

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"          # ~1.3 GB; Docling pulls torch
python -m doc_converter.app
```

No configuration needed — every setting has a working default. The first start
loads the models (60–110 s) before it listens; `curl localhost:5001/healthz`
confirms it is up.

### Offline

Docling downloads its weights on first use. To bake them in instead:

```bash
docling-tools models download -o ./models layout tableformer   # ~510 MB
echo "MODELS_DIR=./models" >> .env
```

Verified with `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`: the service starts and
converts with no network at all.

## API

**`POST /convert`** — `multipart/form-data`, field `file`. Send
`Authorization: Bearer <API_TOKEN>` only if `API_TOKEN` is set.

```bash
curl -X POST localhost:5001/convert -F "file=@runbook.pdf"
```

```json
{ "markdown": "## Runbook…", "pages": 3, "engine": "docling", "duration_ms": 828 }
```

| Code | Meaning |
|---|---|
| `400` | no `file` field |
| `401` | wrong or missing token |
| `413` | over `MAX_UPLOAD_BYTES` |
| `415` | not a PDF — checked by file header, not extension |
| `422` | the PDF opened but yielded almost no text (e.g. a scan with OCR off) |

**`GET /healthz`** — `{"status":"ok","engine":"docling","ocr":false,…}`

## Configuration

Environment variables, or a `.env` file in this directory.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5001` | every other port is taken by the rest of the stack |
| `API_TOKEN` | empty | bearer token; empty disables the check |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS allowlist |
| `MAX_UPLOAD_BYTES` | `15728640` | mirrors the client's own 15 MB cap |
| `MODELS_DIR` | empty | pre-fetched weights, for offline use |
| `ENABLE_OCR` | `false` | for scanned PDFs; +62 MB and slower per page |
| `ENABLE_CODE_ENRICHMENT` | `false` | see the limitation below |
| `CONVERSION_TIMEOUT_SECONDS` | `120` | per document |

### Optional: describe figures with a vision model

The only setting that involves a model outside this machine, and it only
affects **pictures** — never layout, headings or tables. Off by default; with
it off, figures are simply skipped and everything else is identical.

| Variable | Default |
|---|---|
| `ENABLE_PICTURE_DESCRIPTION` | `false` |
| `VLM_API_URL` | `http://localhost:11434/v1/chat/completions` |
| `VLM_API_KEY` | empty |
| `VLM_MODEL` | `llava` |

The endpoint is OpenAI-compatible, so the provider is the user's choice: Ollama
locally with no key, or OpenAI with one. An empty key sends no `Authorization`
header at all.

## Known limitation: multi-line code and YAML

Docling detects and fences code blocks but **flattens them onto one line**. A
PrometheusRule comes out as `groups: - name: pod-health rules: - alert: …`,
which is not valid YAML. Nothing errors — the table beside it is perfect — so
this is silent and would surface much later as bad RAG answers.

`ENABLE_CODE_ENRICHMENT=true` fixes it, but pulls a 611 MB model and costs
~150× the conversion time (0.5 s → 74.7 s for one page).

**The standing rule instead: runbooks we author go in as Markdown, never as
PDF.** The client passes `.md`/`.txt` through untouched, and this service
rejects them with `415` so nobody bypasses that path by accident.

## Tests

```bash
pytest -q
```

16 tests, none of which load Docling: `validate_upload` is pure and the HTTP
layer takes an injected pipeline, so the suite runs in 0.2 s with no models on
disk.

## Design notes

- **Flask, not FastAPI** as in `agent-core` — one endpoint does not need more.
  The cost is two web frameworks in one repo.
- **Separate service, not part of `agent-core`**, whose `webhook_server.py`
  refuses to start when the observability stack is down. Adding a runbook
  should not depend on that. It also keeps torch out of `agent-core`'s six
  pure-Python dependencies.
- **Host process, not a cluster pod.** Docling peaks around 3.4 GB RSS on 8
  pages; the closest Helm analogue in this repo caps at 150 Mi, and Docling's
  own manifests ask for 4 Gi and a GPU.
- **Single-threaded** for the same reason.
- **`allowed_formats=[InputFormat.PDF]`** drops the HTML, LaTeX and XML parsing
  paths where Docling's CVEs have lived.
