# IDAR RAG server

Backend of the RAG knowledge base: ingests documentation (chunking + embeddings)
into Qdrant and serves semantic search to the diagnostic agents.

Where it fits in the system: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

## Requirements

- [uv](https://docs.astral.sh/uv/) (it fetches Python 3.12 itself)
- [Ollama](https://ollama.com/) with the embedding model:
  `ollama pull qwen3-embedding:0.6b`
- Docker (Qdrant through `docker compose`)

## Start

```bash
docker compose up -d qdrant
uv run fastapi dev app/main.py --port 8100
```

Port 8100 on purpose, not the default 8000: in the demo environment port 8000 is
taken by the port-forward of the Grafana MCP server.

Health check (verifies Qdrant and the embedding provider, returns the model and the
dimension): <http://localhost:8100/api/health>. API docs: <http://localhost:8100/docs>.

Configuration through `IDAR_*` variables, see [`.env.example`](.env.example) (copy
it to `.env` to override the defaults; in production
`IDAR_EMBEDDING_MODEL=qwen3-embedding:8b`). The most important ones besides the model:

| Variable | Default | Meaning |
| --- | --- | --- |
| `IDAR_CORS_ORIGINS` | `http://localhost:5173,http://localhost:3000` | panel origins (Vite dev, Nginx container); empty = any |
| `IDAR_API_TOKEN` | empty | when set, `/api/documents*` and `/api/search` require `Authorization: Bearer <token>` |
| `IDAR_STARTUP_RETRIES` / `IDAR_STARTUP_RETRY_SECONDS` | `30` / `2` | how long to wait for Ollama and Qdrant at startup (containers start in parallel) |

## Search contract (for agents)

`POST /api/search` is a team interface: the diagnostic agents use it as their
retrieval tool. The full specification is in Swagger (`/docs`); a quick test:

```bash
curl -X POST http://localhost:8100/api/search -H "Content-Type: application/json" -d "{\"query\": \"the pod keeps restarting, what should I check?\", \"top_k\": 5}"
```

Response: `results[]` (text with the section breadcrumb, score, doc_id, title,
section_path, author, doc_date, chunk_index) plus the `embedding_model` and
`collection` the result was computed on. Optional `filters` (author, date_from,
date_to) and `score_threshold`. Change the contract only after agreeing on it with
the team.

## Docker

The image follows the conventions of the other IDAR images (`docs/CONTAINERS.md`):
`python:3.12-slim-bookworm`, multi-stage, user `10003:10003` (the agent has 10001,
the converter 10002), port `8080` in the container, `HEALTHCHECK` on `/healthz`.
`uv sync --frozen` installs the dependencies from `uv.lock`, so the image is
reproducible. The embedding model is **not** in the image: it lives in Ollama and the
vectors in Qdrant; the API container itself is stateless.

Probes: `/healthz` is a shallow liveness check (the process is up), `/api/health` is
readiness (Qdrant + a test embedding; `503` when something is down). If liveness
checked Ollama, every hiccup of Ollama would restart the API.

### Compose: three modes

```bash
docker compose up -d qdrant            # development: API from uv, Ollama on the host
docker compose up -d --build           # Qdrant + API in Docker, Ollama on the host
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d --build   # everything in Docker
```

- **Ollama on the host** (Windows/macOS with Docker Desktop): the API connects
  through `host.docker.internal:11434`, and a native Ollama uses the GPU with no
  setup. On Linux, Ollama must listen beyond `127.0.0.1` (`OLLAMA_HOST=0.0.0.0`).
- **Ollama in a container** (`docker-compose.ollama.yml`): the one-off `ollama-pull`
  service pulls `IDAR_EMBEDDING_MODEL` (from `.env`, or the default `0.6b`), and the
  API starts only after it succeeds. NVIDIA GPU: uncomment the `deploy` block (Docker
  Desktop: WSL2 + the NVIDIA driver). Without a GPU, `0.6b` runs well on the CPU and
  `8b` is much slower (ingesting a large document takes minutes).

The containerized API is at <http://localhost:8100> (port mapping `8100:8080`).
A local `.env` is loaded when present, but compose overrides `IDAR_QDRANT_URL` and
`IDAR_OLLAMA_URL`: `localhost` inside a container is the container itself.
Qdrant data lives in the `qdrant_storage` volume and Ollama models in
`ollama_models`; `docker compose down` keeps them, `down -v` deletes them.

### The image alone (`docker run`, as in CONTAINERS.md)

```bash
docker build -t idar-rag-server:local ./server
docker run -d --name idar-rag-server --restart unless-stopped \
  -e IDAR_QDRANT_URL=http://QDRANT_HOST:6333 \
  -e IDAR_OLLAMA_URL=http://OLLAMA_HOST:11434 \
  -e IDAR_EMBEDDING_MODEL=qwen3-embedding:0.6b \
  -e IDAR_CORS_ORIGINS=http://localhost:3000 \
  -e IDAR_API_TOKEN=CHANGE_ME \
  -p 127.0.0.1:8100:8080 \
  idar-rag-server:local
curl --fail http://localhost:8100/healthz
```

The image is pure Python (no architecture-specific steps), so
`docker buildx build --platform linux/amd64,linux/arm64` works the same as for the
other images.

### Kubernetes

The manifests are in [`k8s/`](../k8s/): `rag-server.yaml`, `qdrant.yaml` and
`ollama.yaml`, deployed as described in [`k8s/README.md`](../k8s/README.md).
rag-server is a stateless Deployment (liveness `/healthz`, readiness `/api/health`),
Qdrant a StatefulSet with a volume, and Ollama a Deployment that pulls the model onto
its volume before it starts. The panel gets the API address as `VITE_RAG_API_URL` at
build time: an address the browser can reach, not a cluster DNS name.

## Known issues (Windows + Smart App Control)

On machines with Smart App Control enabled ("An Application Control policy has
blocked this file"; on Polish Windows „Zasady kontroli aplikacji zablokowały ten
plik"):

- `grpcio` is pinned in `pyproject.toml` on purpose, to a release that has a
  reputation; do not bump it without checking that `import grpc` still works.
- The console scripts in `.venv\Scripts` (`pytest.exe`, `fastapi.exe`) are uv
  trampolines without a reputation. When SAC blocks them (`Failed to spawn`,
  os error 4551), run the modules through the interpreter: `uv run python -m pytest`,
  `uv run python -m uvicorn app.main:app --reload --port 8100` (instead of `fastapi dev`).
- If `.venv\Scripts\python.exe` itself is blocked (uv creates it as a unique
  trampoline without a reputation), recreate the venv the classic way:

  ```powershell
  Remove-Item -Recurse -Force .venv
  & (uv python find 3.12) -m venv .venv
  uv sync
  ```

- If SAC blocks a DLL of the uv-managed Python itself (for example
  `DLL load failed while importing unicodedata`), no venv trick helps. Run the tests
  in a Linux container instead, from `server/` (append `-m slow` inside the quotes
  for the semantic tests against the host's Ollama):

  ```powershell
  docker run --rm -v "${PWD}:/src:ro" -w /src `
    -e UV_PROJECT_ENVIRONMENT=/tmp/venv -e UV_PYTHON_PREFERENCE=system `
    -e IDAR_OLLAMA_URL=http://host.docker.internal:11434 `
    python:3.12-slim-bookworm `
    sh -c "pip install -q uv==0.12.5 && uv sync --frozen -q && uv run --frozen python -m pytest -p no:cacheprovider"
  ```

- Python from the Microsoft Store is not fit for development (its MSIX container
  blocks unsigned DLLs), hence `python-preference = "only-managed"`. In the Docker
  image `UV_PYTHON_PREFERENCE=system` overrides that setting.

## Tests and lint

```bash
uv run python -m pytest            # fast tests (FakeEmbedder, Qdrant :memory:)
uv run python -m pytest -m slow    # semantic tests on the real model (need Ollama)
uv run ruff check .
uv run ruff format --check .
```

`python -m pytest` instead of `pytest`: the `.venv\Scripts\*.exe` scripts are uv
trampolines without a reputation, which Smart App Control can start blocking from
one day to the next (see above); the interpreter and `ruff.exe` are signed and pass.
