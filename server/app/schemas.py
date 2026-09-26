from datetime import date

from pydantic import BaseModel, ConfigDict, Field

# Matches the upload limit in the frontend (15 MB).
MAX_CONTENT_LENGTH = 15 * 1024 * 1024


class DocumentIn(BaseModel):
    """Ingest contract, 1:1 with the frontend payload. The JSON keys stay Polish
    (data / autor / tresc) because the team agreed on them and froze them; the
    aliases keep them on the wire while the code uses English names."""

    model_config = ConfigDict(str_strip_whitespace=True)

    doc_date: date = Field(alias="data")
    author: str = Field(alias="autor", min_length=1, max_length=200)
    content: str = Field(alias="tresc", min_length=1, max_length=MAX_CONTENT_LENGTH)


class DocumentIngestResponse(BaseModel):
    doc_id: str
    title: str
    chunk_count: int
    already_exists: bool = False


class DocumentSummary(BaseModel):
    doc_id: str
    title: str
    author: str
    doc_date: str
    chunk_count: int
    ingested_at: str


class DocumentListResponse(BaseModel):
    documents: list[DocumentSummary]


class SearchFilters(BaseModel):
    author: str | None = None
    date_from: date | None = None
    date_to: date | None = None


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)
    filters: SearchFilters = Field(default_factory=SearchFilters)
    # Optional until the evaluation harness shows what a sensible threshold is.
    score_threshold: float | None = Field(default=None, ge=-1.0, le=1.0)


class SearchResult(BaseModel):
    text: str
    score: float
    doc_id: str
    title: str
    section_path: list[str]
    author: str
    doc_date: str
    chunk_index: int


class SearchResponse(BaseModel):
    results: list[SearchResult]
    embedding_model: str
    collection: str
