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
`IDAR_EMBEDDING_MODEL=qwen3-embedding:8b`).

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

## Testy i lint

```bash
uv run pytest              # szybkie testy (FakeEmbedder, Qdrant :memory:)
uv run pytest -m slow      # testy semantyczne na prawdziwym modelu (wymagają Ollamy)
uv run ruff check .
uv run ruff format --check .
```
