# doc-converter — lokalna konwersja dokumentów do Markdown

Serwis konwertujący PDF-y do Markdown na potrzeby bazy wiedzy RAG. Zastępuje
dotychczasową konwersję przez Google Gemini wykonywaną **w przeglądarce**.

## Po co on powstał

Wcześniej klient wysyłał PDF prosto do Gemini z poziomu przeglądarki. Miało to
trzy konsekwencje, z których każda sama w sobie uzasadnia tę zmianę:

1. **`VITE_GEMINI_API_KEY` trafiał do publicznego bundla JS** — każdy użytkownik
   panelu widział klucz (ostrzega o tym `client/README.md`).
2. **Dokumenty wychodziły poza infrastrukturę.** Runbooki i post-mortemy to
   wewnętrzna dokumentacja operacyjna; wysyłanie ich do zewnętrznego dostawcy
   jest osobnym problemem od kosztów i limitów.
3. Limity i błędy dostawcy trzeba było obchodzić po stronie frontu (retry z
   backoffem 1s/2s/4s) — kod, który teraz znika.

Serwis rozwiązuje wszystkie trzy: konwersja dzieje się lokalnie, klucz nie jest
potrzebny, a dokument nie opuszcza maszyny.

## Silnik: Docling

[Docling](https://github.com/docling-project/docling) (MIT, IBM Research → LF AI
& Data, OpenSSF Best Practices 100%, [arXiv:2408.09869](https://arxiv.org/abs/2408.09869)).

Wybrany, bo jako jedyny z rozważanych narzędzi odtwarza **strukturę**, a nie
tylko tekst. Zmierzone na runbooku z tabelą eskalacji i blokiem PromQL:

| | nagłówki ATX | tabela GFM |
|---|---|---|
| Docling | 6 | 4 kolumny, komórka w komórkę |
| MarkItDown | 0 | rozsypana w luźne linie |

MarkItDown odpadł nie z gustu, tylko architektonicznie: jego konwerter PDF nie
zawiera ścieżki kodu zdolnej wyprodukować nagłówek ani blok kodu. Podpięcie do
niego LLM-a tego nie zmienia — LLM opisuje tam obrazki, nie odtwarza układu
strony.

**Docling nie używa żadnego LLM-a ani klucza API.** Jego modele to małe modele
wizyjne do analizy układu strony i struktury tabel:

| model | rozmiar | rola |
|---|---|---|
| layout-heron | 164 MB | co jest nagłówkiem, akapitem, tabelą, listą |
| TableFormer | 342 MB | która komórka do którego wiersza i kolumny |
| RapidOCR | 61 MB | OCR skanów (opcjonalny, `ENABLE_OCR`) |

### Znane ograniczenie: wielolinijkowy kod i YAML

Docling poprawnie wykrywa i ofencowuje blok kodu, ale **spłaszcza go do jednej
linii**. Blok PrometheusRule wychodzi jako `groups: - name: pod-health rules: -
alert: …`, co jako YAML jest bezwartościowe. Nic przy tym nie zgłasza błędu —
tabela obok jest idealna, nagłówki czyste — więc problem jest **cichy** i
wyjdzie dopiero jako złe odpowiedzi RAG-a.

`ENABLE_CODE_ENRICHMENT=true` to naprawia, ale kosztuje 611 MB modelu i ~150×
czasu konwersji (zmierzone: 0,5 s → 74,7 s na jedną stronę). Dlatego domyślnie
jest wyłączone, a **obowiązująca zasada brzmi: runbooki, które piszemy sami,
wchodzą jako Markdown, nigdy jako PDF.** Ścieżka passthrough w kliencie daje dla
nich bajt w bajt poprawny YAML, a ten serwis odrzuca `.md`/`.txt` z kodem 415,
żeby nikt jej przypadkiem nie ominął.

## Uruchomienie

```bash
cd doc-converter
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"            # ~1,3 GB, kilka minut (torch i spółka)

cp .env.example .env               # domyślne wartości są sensowne lokalnie
python -m doc_converter.app
```

Pierwsze uruchomienie ładuje modele (60–110 s) — dzieje się to przy starcie, nie
przy pierwszym żądaniu użytkownika. Sprawdzenie: `curl http://localhost:5001/healthz`.

### Tryb w pełni offline

Domyślnie Docling dociąga wagi przy pierwszym użyciu. Żeby serwis działał bez
sieci (i żeby dało się go odtworzyć za dwa lata), pobierz je raz do katalogu:

```bash
# w .env: MODELS_DIR=./models
python scripts/prefetch_models.py
```

Ściąga ~510 MB (bez OCR) zamiast domyślnych ~1,37 GB — pomija modele, których
ten serwis nigdy nie włącza. Weryfikacja:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python -m doc_converter.app
```

## API

### `POST /convert`

`multipart/form-data`, pole `file`. Nagłówek `Authorization: Bearer <API_TOKEN>`
tylko jeśli `API_TOKEN` jest ustawiony.

```bash
curl -X POST http://localhost:5001/convert \
  -H "Authorization: Bearer $API_TOKEN" \
  -F "file=@runbook.pdf"
```

```json
{ "markdown": "## Runbook…", "pages": 3, "engine": "docling", "duration_ms": 828 }
```

| kod | znaczenie |
|---|---|
| `400` | brak pola `file` |
| `401` | zły lub brakujący token |
| `413` | plik ponad `MAX_UPLOAD_BYTES` (domyślnie 15 MB, tyle co limit klienta) |
| `415` | to nie jest PDF — sprawdzane po nagłówku pliku, nie po rozszerzeniu |
| `422` | PDF się otworzył, ale nie dało się wyciągnąć treści (np. skan przy `ENABLE_OCR=false`) |

### `GET /healthz`

```json
{ "status": "ok", "engine": "docling", "ocr": false }
```

## Konfiguracja

Wszystkie zmienne opisane w [`.env.example`](.env.example). Najważniejsze:
`API_TOKEN`, `ALLOWED_ORIGINS`, `MODELS_DIR`, `ENABLE_OCR`,
`ENABLE_CODE_ENRICHMENT`.

## Testy

```bash
pytest -q
```

22 testy, wszystkie bez ładowania Doclinga — `validate_upload` jest czyste, a
warstwa HTTP dostaje podstawiony pipeline. Dzięki temu suite chodzi w 0,2 s i
nie wymaga pobranych modeli.

## Decyzje projektowe

- **Flask, nie FastAPI**, mimo że `agent-core` stoi na FastAPI. Ten serwis ma
  jeden endpoint konwersji i healthcheck; Flask wystarcza i jest prostszy.
  Świadomy koszt: dwa frameworki webowe w jednym repo.
- **Osobny serwis, nie moduł w `agent-core`.** `webhook_server.py` nie wstaje,
  gdy `MCP_GRAFANA_URL` jest nieosiągalny — dokładanie tam konwersji oznaczałoby,
  że dodawanie runbooka przestaje działać, gdy leży stack obserwowalności. Poza
  tym `agent-core` ma sześć czysto pythonowych zależności i dokładanie do tego
  drzewa torcha zniszczyłoby tę własność.
- **Proces hosta, nie kontener w klastrze.** Docling przy 8 stronach bierze
  ~3,4 GB RSS; najbliższy analog w Waszym Helmie (`grafana-mcp`) ma limit
  150 Mi, a oficjalne manifesty Doclinga proszą o 4 Gi i GPU. Na laptopie ze
  stackiem obserwowalności to się nie mieści.
- **Jeden wątek (`threaded=False`).** Jedna konwersja naraz — równoległe
  żądania zwielokrotniłyby zużycie pamięci.
- **`allowed_formats=[InputFormat.PDF]`** — to zabezpieczenie, nie porządki:
  usuwa ścieżki parsowania HTML, LaTeX i XML, w których historycznie siedziały
  CVE Doclinga.
- **Format pliku sprawdzany po magic bytes**, nie po rozszerzeniu ani po
  `Content-Type` z przeglądarki.
