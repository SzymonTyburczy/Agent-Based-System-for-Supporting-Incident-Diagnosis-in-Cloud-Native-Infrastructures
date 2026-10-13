import re
import unicodedata
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
    # Optional and added after the contract was frozen, so older clients keep
    # working. Only shown to people (the knowledge base list, citations), never
    # used as a path.
    file_name: str | None = Field(default=None, alias="nazwa_pliku", max_length=255)

    @field_validator("file_name")
    @classmethod
    def _keep_basename(cls, value: str | None) -> str | None:
        """A bare name: a client may send a full path (a Windows one too), and a
        newline or another control character would break the list it is shown in."""
        if value is None:
            return None
        printable = "".join(char for char in value if unicodedata.category(char) != "Cc")
        return re.split(r"[/\\]", printable)[-1].strip() or None


class DocumentIngestResponse(BaseModel):
    doc_id: str
    title: str
    chunk_count: int
    already_exists: bool = False


class DocumentSummary(BaseModel):
    doc_id: str
    title: str
    # None for a document ingested without a file name, or before they were stored.
    file_name: str | None = None
    author: str
    doc_date: str
    chunk_count: int
    ingested_at: str


class DocumentDetail(DocumentSummary):
    content: str
    # "reconstructed": a document ingested before the full Markdown was stored,
    # put back together from its chunks, so only close to the original.
    content_source: Literal["stored", "reconstructed"]


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
    file_name: str | None = None
    section_path: list[str]
    author: str
    doc_date: str
    chunk_index: int


class SearchResponse(BaseModel):
    results: list[SearchResult]
    embedding_model: str
    collection: str
