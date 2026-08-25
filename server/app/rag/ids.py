import hashlib
import uuid

_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "idar-kb")


def doc_id(tresc: str) -> str:
    """Identyfikator adresowany treścią — ponowny upload identycznego dokumentu
    dostaje ten sam doc_id, więc ingest jest idempotentny bez żadnych transakcji."""
    return hashlib.sha256(tresc.encode("utf-8")).hexdigest()[:16]


def point_id(document_id: str, chunk_index: int) -> str:
    return str(uuid.uuid5(_NAMESPACE, f"{document_id}:{chunk_index}"))
