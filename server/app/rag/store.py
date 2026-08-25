import re
from dataclasses import dataclass
from datetime import date

from qdrant_client import QdrantClient, models

from app.rag.chunking import Chunk
from app.rag.ids import point_id

DENSE_VECTOR = "dense"
SCHEMA_VERSION = 1

_SUMMARY_FIELDS = ["doc_id", "title", "author", "doc_date", "chunk_count", "ingested_at"]


def collection_name(model_id: str, dimension: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", model_id.lower()).strip("_")
    return f"kb__{slug}__{dimension}__v{SCHEMA_VERSION}"


@dataclass(frozen=True)
class DocumentMeta:
    doc_id: str
    title: str
    author: str
    doc_date: str
    embedding_model: str
    ingested_at: str


class QdrantStore:
    """Wszystkie operacje idą przez alias — nazwa kolekcji koduje model i wymiar,
    a podmiana modelu to atomowe przepięcie aliasu na kolekcję nowego modelu."""

    def __init__(self, client: QdrantClient, alias: str) -> None:
        self._client = client
        self.alias = alias

    def ensure_collection(self, model_id: str, dimension: int) -> str:
        name = collection_name(model_id, dimension)
        if not self._client.collection_exists(name):
            self._client.create_collection(
                collection_name=name,
                vectors_config={
                    DENSE_VECTOR: models.VectorParams(
                        size=dimension, distance=models.Distance.COSINE
                    )
                },
            )
            self._client.create_payload_index(name, "doc_id", models.PayloadSchemaType.KEYWORD)
            self._client.create_payload_index(name, "author", models.PayloadSchemaType.KEYWORD)
            self._client.create_payload_index(name, "doc_date", models.PayloadSchemaType.DATETIME)
        if self.collection != name:
            self._client.update_collection_aliases(
                change_aliases_operations=[
                    models.CreateAliasOperation(
                        create_alias=models.CreateAlias(collection_name=name, alias_name=self.alias)
                    )
                ]
            )
        return name

    @property
    def collection(self) -> str | None:
        """Kolekcja, na którą wskazuje alias — raportowana w odpowiedziach API,
        żeby w logach eksperymentów było widać, na czym liczono wynik."""
        for record in self._client.get_aliases().aliases:
            if record.alias_name == self.alias:
                return record.collection_name
        return None

    def upsert_chunks(
        self, meta: DocumentMeta, chunks: list[Chunk], vectors: list[list[float]]
    ) -> None:
        points = [
            models.PointStruct(
                id=point_id(meta.doc_id, chunk.index),
                vector={DENSE_VECTOR: vector},
                payload={
                    "doc_id": meta.doc_id,
                    "title": meta.title,
                    "author": meta.author,
                    "doc_date": meta.doc_date,
                    "chunk_index": chunk.index,
                    "chunk_count": len(chunks),
                    "section_path": list(chunk.section_path),
                    "text": chunk.text,
                    "embedding_model": meta.embedding_model,
                    "ingested_at": meta.ingested_at,
                },
            )
            for chunk, vector in zip(chunks, vectors, strict=True)
        ]
        self._client.upsert(collection_name=self.alias, points=points)

    def _doc_filter(self, document_id: str) -> models.Filter:
        return models.Filter(
            must=[models.FieldCondition(key="doc_id", match=models.MatchValue(value=document_id))]
        )

    def count_chunks(self, document_id: str) -> int:
        result = self._client.count(
            self.alias, count_filter=self._doc_filter(document_id), exact=True
        )
        return result.count

    def document_exists(self, document_id: str) -> bool:
        return self.count_chunks(document_id) > 0

    def delete_document(self, document_id: str) -> bool:
        if not self.document_exists(document_id):
            return False
        self._client.delete(
            self.alias, points_selector=models.FilterSelector(filter=self._doc_filter(document_id))
        )
        return True

    def query(
        self,
        vector: list[float],
        *,
        top_k: int,
        author: str | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        score_threshold: float | None = None,
    ) -> list[models.ScoredPoint]:
        conditions: list[models.FieldCondition] = []
        if author:
            conditions.append(
                models.FieldCondition(key="author", match=models.MatchValue(value=author))
            )
        if date_from or date_to:
            conditions.append(
                models.FieldCondition(
                    key="doc_date", range=models.DatetimeRange(gte=date_from, lte=date_to)
                )
            )
        result = self._client.query_points(
            self.alias,
            query=vector,
            using=DENSE_VECTOR,
            limit=top_k,
            query_filter=models.Filter(must=conditions) if conditions else None,
            score_threshold=score_threshold,
            with_payload=True,
        )
        return result.points

    def list_documents(self) -> list[dict]:
        summaries: dict[str, dict] = {}
        offset = None
        while True:
            points, offset = self._client.scroll(
                self.alias,
                limit=256,
                offset=offset,
                with_payload=_SUMMARY_FIELDS,
                with_vectors=False,
            )
            for point in points:
                payload = point.payload or {}
                summaries.setdefault(payload.get("doc_id", ""), payload)
            if offset is None:
                break
        return sorted(summaries.values(), key=lambda p: p.get("ingested_at", ""), reverse=True)
