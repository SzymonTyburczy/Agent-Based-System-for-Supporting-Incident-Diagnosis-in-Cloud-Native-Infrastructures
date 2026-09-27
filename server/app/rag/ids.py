import hashlib
import uuid

_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "idar-kb")


def doc_id(content: str) -> str:
    """Content-addressed id: uploading an identical document again gives the same
    doc_id, so ingest is idempotent without any transactions."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def point_id(document_id: str, chunk_index: int) -> str:
    return str(uuid.uuid5(_NAMESPACE, f"{document_id}:{chunk_index}"))
