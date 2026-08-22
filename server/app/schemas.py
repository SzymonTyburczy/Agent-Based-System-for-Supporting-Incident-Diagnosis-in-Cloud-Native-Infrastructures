from datetime import date

from pydantic import BaseModel, ConfigDict, Field

# Spójnie z limitem uploadu we frontendzie (15 MB).
MAX_TRESC_LENGTH = 15 * 1024 * 1024


class DocumentIn(BaseModel):
    """Kontrakt ingestu 1:1 z payloadem frontendu — pola celowo po polsku
    (data / autor / tresc), uzgodnione zespołowo i zamrożone."""

    model_config = ConfigDict(str_strip_whitespace=True)

    data: date
    autor: str = Field(min_length=1, max_length=200)
    tresc: str = Field(min_length=1, max_length=MAX_TRESC_LENGTH)


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
