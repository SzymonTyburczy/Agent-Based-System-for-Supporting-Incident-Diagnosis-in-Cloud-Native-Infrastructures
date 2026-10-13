import re
from dataclasses import dataclass
from datetime import date
from itertools import batched

from qdrant_client import QdrantClient, models

from app.rag.chunking import Chunk, breadcrumb
from app.rag.ids import point_id

DENSE_VECTOR = "dense"
SCHEMA_VERSION = 1
# Qdrant rejects a request body over 32 MB (service.max_request_size_mb), and a
# 4096-dim point is ~90 KB of JSON, so a few hundred chunks cannot go in one
# request.
UPSERT_BATCH_SIZE = 64

_SUMMARY_FIELDS = [
    "doc_id",
    "title",
    "file_name",
    "author",
    "doc_date",
    "chunk_count",
    "ingested_at",
]


def collection_name(model_id: str, dimension: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", model_id.lower()).strip("_")
    return f"kb__{slug}__{dimension}__v{SCHEMA_VERSION}"


@dataclass(frozen=True)
class DocumentMeta:
    doc_id: str
    title: str
    file_name: str | None
    author: str
    doc_date: str
    embedding_model: str
    ingested_at: str


class QdrantStore:
    """Every operation goes through the alias. The collection name encodes the
    model and the dimension, and switching models atomically moves the alias to
    the new model's collection."""

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
        """The collection the alias points to. API responses report it, so
        experiment logs show which collection a result was computed on."""
        for record in self._client.get_aliases().aliases:
            if record.alias_name == self.alias:
                return record.collection_name
        return None

    def upsert_chunks(
        self,
        meta: DocumentMeta,
        chunks: list[Chunk],
        vectors: list[list[float]],
        *,
        content: str,
    ) -> None:
        """Stores the chunks, and on the first one the full Markdown, which
        the knowledge base view shows and citations point into."""
        points = [
            models.PointStruct(
                id=point_id(meta.doc_id, chunk.index),
                vector={DENSE_VECTOR: vector},
                payload={
                    "doc_id": meta.doc_id,
                    "title": meta.title,
                    "file_name": meta.file_name,
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
        try:
            for batch in batched(points, UPSERT_BATCH_SIZE):
                self._client.upsert(collection_name=self.alias, points=list(batch))
            # A request of its own: up to 15 MB of text in the first batch,
            # next to its vectors, would get close to Qdrant's request limit.
            self._set_content(meta.doc_id, content)
        except Exception:
            # Best effort: a failed ingest should leave nothing behind. When
            # Qdrant cannot take this delete either, the leftover chunks fail
            # document_complete, so the next upload ingests the document again.
            self.delete_document(meta.doc_id)
            raise

    def _doc_filter(self, document_id: str) -> models.Filter:
        return models.Filter(
            must=[models.FieldCondition(key="doc_id", match=models.MatchValue(value=document_id))]
        )

    def _set_content(self, document_id: str, content: str) -> None:
        self._client.set_payload(
            self.alias, payload={"content": content}, points=[point_id(document_id, 0)]
        )

    def _first_chunk_lacks(self, document_id: str, key: str) -> bool:
        """Whether the payload key is missing (or null) on the document's first
        chunk. A count, so checking for the content does not download it."""
        lacking = models.Filter(
            must=[
                models.HasIdCondition(has_id=[point_id(document_id, 0)]),
                models.IsEmptyCondition(is_empty=models.PayloadField(key=key)),
            ]
        )
        return self._client.count(self.alias, count_filter=lacking, exact=True).count > 0

    def backfill_document(self, document_id: str, *, file_name: str | None, content: str) -> None:
        """Upgrades a document ingested before file names and the full Markdown
        were stored, when the same file is sent again. A file name already
        stored is kept: the doc_id is a hash of the content, so a copy under
        another name is the same document."""
        if file_name and self._first_chunk_lacks(document_id, "file_name"):
            self._client.set_payload(
                self.alias,
                payload={"file_name": file_name},
                points=models.FilterSelector(filter=self._doc_filter(document_id)),
            )
        if self._first_chunk_lacks(document_id, "content"):
            self._set_content(document_id, content)

    def count_chunks(self, document_id: str) -> int:
        result = self._client.count(
            self.alias, count_filter=self._doc_filter(document_id), exact=True
        )
        return result.count

    def document_exists(self, document_id: str) -> bool:
        return self.count_chunks(document_id) > 0

    def document_complete(self, document_id: str) -> bool:
        """Whether every chunk of the document is stored: as many as the
        `chunk_count` each of them carries. An ingest that failed midway, with
        its cleanup failing too, leaves fewer."""
        points, _ = self._client.scroll(
            self.alias,
            scroll_filter=self._doc_filter(document_id),
            limit=1,
            with_payload=["chunk_count"],
            with_vectors=False,
        )
        if not points:
            return False
        return self.count_chunks(document_id) == (points[0].payload or {}).get("chunk_count")

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
            # The full Markdown on a document's first chunk: search results stay light.
            with_payload=models.PayloadSelectorExclude(exclude=["content"]),
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

    def get_document(self, document_id: str) -> dict | None:
        """The document's summary fields plus its full Markdown in `content`;
        None when no such document is stored."""
        records = self._client.retrieve(
            self.alias,
            ids=[point_id(document_id, 0)],
            with_payload=[*_SUMMARY_FIELDS, "content"],
            with_vectors=False,
        )
        if not records:
            return None
        document = dict(records[0].payload or {})
        if "content" in document:
            document["content_source"] = "stored"
        else:
            document["content"] = self._reconstruct_content(document_id)
            document["content_source"] = "reconstructed"
        return document

    def _reconstruct_content(self, document_id: str) -> str:
        """The chunks of a document ingested before its Markdown was stored,
        in order and without their breadcrumbs. Close to the original, not
        equal to it: a heading with no text of its own made no chunk, the
        overlap between the pieces of a long paragraph repeats, and chunks
        from before the verbatim chunker lost their indentation."""
        chunks: list[dict] = []
        offset = None
        while True:
            points, offset = self._client.scroll(
                self.alias,
                scroll_filter=self._doc_filter(document_id),
                limit=256,
                offset=offset,
                with_payload=["text", "chunk_index", "section_path"],
                with_vectors=False,
            )
            chunks.extend(point.payload or {} for point in points)
            if offset is None:
                break
        texts: list[str] = []
        for chunk in sorted(chunks, key=lambda c: c["chunk_index"]):
            text, path = chunk["text"], chunk["section_path"]
            if path:
                text = text.removeprefix(breadcrumb(path))
            texts.append(text)
        return "\n\n".join(texts)
