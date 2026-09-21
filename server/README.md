# IDAR RAG server

Backend bazy wiedzy RAG: ingest dokumentacji (chunking + embeddingi) do Qdranta
i wyszukiwanie semantyczne dla agentów diagnostycznych.

Kontekst projektowy: [plan architektoniczny](../docs/rag-vector-store-plan.md)
i [roadmapa wykonawcza](../docs/rag-implementation-roadmap.md).

## Wymagania

- [uv](https://docs.astral.sh/uv/) (Python 3.12 dociąga sam)
- [Ollama](https://ollama.com/) z modelem embeddingów:
  `ollama pull qwen3-embedding:0.6b`
- Docker (Qdrant przez `docker compose`)

## Start

```bash
docker compose up -d qdrant
uv run fastapi dev app/main.py --port 8100
```

Port 8100 celowo, nie domyślne 8000 — w środowisku demo port 8000 zajmuje
port-forward serwera Grafana MCP.

Health check (weryfikuje Qdranta i provider embeddingów, zwraca model i wymiar):
<http://localhost:8100/api/health>. Dokumentacja API: <http://localhost:8100/docs>.

Konfiguracja przez zmienne `IDAR_*` — patrz [`.env.example`](.env.example)
(skopiuj do `.env`, żeby nadpisać wartości domyślne; produkcyjnie
`IDAR_EMBEDDING_MODEL=qwen3-embedding:8b`). Najważniejsze poza modelem:

| Zmienna | Domyślnie | Znaczenie |
| --- | --- | --- |
| `IDAR_CORS_ORIGINS` | `http://localhost:5173,http://localhost:3000` | originy panelu (Vite dev, kontener Nginx); pusta = dowolny |
| `IDAR_API_TOKEN` | pusty | jeśli ustawiony, `/api/documents*` i `/api/search` wymagają `Authorization: Bearer <token>` |
| `IDAR_STARTUP_RETRIES` / `IDAR_STARTUP_RETRY_SECONDS` | `30` / `2` | ile czekać na Ollamę i Qdranta przy starcie (kontenery wstają równolegle) |

## Kontrakt wyszukiwania (dla agentów)

`POST /api/search` to interfejs zespołowy — agenci diagnostyczni używają go jako
narzędzia retrieval. Pełna specyfikacja w Swaggerze (`/docs`); szybki test:

```bash
curl -X POST http://localhost:8100/api/search -H "Content-Type: application/json" -d "{\"query\": \"pod restartuje sie w petli, co sprawdzic?\", \"top_k\": 5}"
```

Odpowiedź: `results[]` (text z breadcrumbem sekcji, score, doc_id, title,
section_path, author, doc_date, chunk_index) + `embedding_model` i `collection`,
na których policzono wynik. Opcjonalne `filters` (author, date_from, date_to)
i `score_threshold`. Zmiany kontraktu tylko po uzgodnieniu z zespołem.

## Docker

Obraz trzyma się konwencji pozostałych obrazów IDAR (`docs/CONTAINERS.md`):
`python:3.12-slim-bookworm`, multi-stage, użytkownik `10003:10003` (agent ma
10001, konwerter 10002), port `8080` w kontenerze, `HEALTHCHECK` na `/healthz`.
Zależności instaluje `uv sync --frozen` z `uv.lock`, więc obraz jest powtarzalny.
Model embeddingów **nie jest** w obrazie — żyje w Ollamie, a wektory w Qdrancie;
sam kontener API jest bezstanowy.

Sondy: `/healthz` to płytki liveness (proces żyje), `/api/health` to readiness
(Qdrant + próbne embeddowanie; `503`, gdy coś leży). Gdyby liveness sprawdzał
Ollamę, każda jej zadyszka restartowałaby API.

### Compose — trzy tryby

```bash
docker compose up -d qdrant            # development: API z uv, Ollama na hoście
docker compose up -d --build           # Qdrant + API w Dockerze, Ollama na hoście
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d --build   # wszystko w Dockerze
```

- **Ollama na hoście** (Windows/macOS z Docker Desktop): API łączy się przez
  `host.docker.internal:11434`, a natywna Ollama ma GPU bez konfiguracji. Na
  Linuksie Ollama musi nasłuchiwać poza `127.0.0.1` (`OLLAMA_HOST=0.0.0.0`).
- **Ollama w kontenerze** (`docker-compose.ollama.yml`): jednorazowy serwis
  `ollama-pull` dociąga `IDAR_EMBEDDING_MODEL` (z `.env` lub domyślny `0.6b`),
  API startuje dopiero po jego sukcesie. GPU NVIDIA: odkomentuj blok `deploy`
  (Docker Desktop: WSL2 + sterownik NVIDIA). Bez GPU `0.6b` chodzi na CPU,
  `8b` wyraźnie wolniej (ingest dużego dokumentu to minuty).

API w kontenerze jest na <http://localhost:8100> (mapowanie `8100:8080`).
Lokalny `.env` jest wczytywany opcjonalnie, ale adresy `IDAR_QDRANT_URL`
i `IDAR_OLLAMA_URL` compose nadpisuje — `localhost` w kontenerze to sam kontener.
Dane Qdranta są w wolumenie `qdrant_storage`, modele Ollamy w `ollama_models`;
`docker compose down` je zostawia, `down -v` kasuje.

### Sam obraz (`docker run`, jak w CONTAINERS.md)

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

Obraz jest czysto pythonowy (bez kroków zależnych od architektury), więc
`docker buildx build --platform linux/amd64,linux/arm64` działa tak samo jak
dla pozostałych obrazów.

### Kubernetes (uzupełnienie `docs/CLUSTER.md`)

| Workload | Kontroler | Repliki | Storage | Uwagi |
| --- | --- | --- | --- | --- |
| `rag-server` | Deployment | ≥ 1 (bezstanowy) | brak | liveness `/healthz`, readiness `/api/health`, startupProbe ok. 90 s (probe modelu) |
| `qdrant` | StatefulSet (oficjalny chart `qdrant/qdrant`) | 1 | PVC | wersja przypięta jak w compose |
| `ollama` | Deployment | 1 | PVC na modele (`8b` ≈ 5 GB) | węzeł z GPU albo duży CPU; `ollama pull` w init containerze lub Jobie |

Adresy w klastrze: `rag-server.idar.svc.cluster.local:8080`,
`qdrant.idar.svc.cluster.local:6333`, `ollama.idar.svc.cluster.local:11434`.
Startowe zasoby do zmierzenia: rag-server `100m/1 · 256Mi/1Gi`, Qdrant
`250m/1 · 512Mi/2Gi`, Ollama z `8b` `2/4 · 8Gi/12Gi`. Konfiguracja przez
ConfigMap (`IDAR_*`), token w Secret; panel dostaje adres API jako
`VITE_RAG_API_URL` w czasie builda (adres osiągalny z przeglądarki, nie DNS klastra).

## Znane problemy (Windows + Smart App Control)

Na maszynach z włączonym Smart App Control („Zasady kontroli aplikacji
zablokowały ten plik"):

- `grpcio` jest celowo przypięte w `pyproject.toml` do wersji z reputacją —
  nie podbijać bez sprawdzenia, że `import grpc` przechodzi.
- Skrypty konsolowe w `.venv\Scripts` (`pytest.exe`, `fastapi.exe`) to
  trampoliny uv bez reputacji — gdy SAC je zablokuje (`Failed to spawn`,
  os error 4551), uruchamiaj moduły przez interpreter: `uv run python -m pytest`,
  `uv run python -m uvicorn app.main:app --reload --port 8100` (zamiast `fastapi dev`).
- Jeśli blokowany jest sam `.venv\Scripts\python.exe` (uv tworzy go jako
  unikalną trampolinę bez reputacji), odtwórz venv klasycznie:

  ```powershell
  Remove-Item -Recurse -Force .venv
  & (uv python find 3.12) -m venv .venv
  uv sync
  ```

- Python z Microsoft Store nie nadaje się do developmentu (kontener MSIX
  blokuje niepodpisane DLL-e) — dlatego `python-preference = "only-managed"`.
  W obrazie Dockera to ustawienie nadpisuje `UV_PYTHON_PREFERENCE=system`.

## Testy i lint

```bash
uv run python -m pytest            # szybkie testy (FakeEmbedder, Qdrant :memory:)
uv run python -m pytest -m slow    # testy semantyczne na prawdziwym modelu (wymagają Ollamy)
uv run ruff check .
uv run ruff format --check .
```

`python -m pytest` zamiast `pytest`: skrypty `.venv\Scripts\*.exe` to trampoliny
uv bez reputacji, które Smart App Control potrafi zablokować z dnia na dzień
(patrz niżej); interpreter i `ruff.exe` są podpisane i przechodzą.
