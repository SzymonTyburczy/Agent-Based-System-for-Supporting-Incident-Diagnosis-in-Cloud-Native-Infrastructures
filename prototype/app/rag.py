"""
RAG (Retrieval-Augmented Generation) Module
============================================
Uses ChromaDB as a local vector store and Google's text-embedding-004
model to index technical documentation and perform semantic search.

On startup (called from main.py lifespan), all .md files in the docs/
directory are chunked, embedded, and stored in ChromaDB. During
diagnosis, the agent queries the collection with the alert context and
retrieves the top-k most relevant documentation chunks.
"""

import os
import re
import hashlib
import logging
from pathlib import Path

import chromadb
from chromadb.config import Settings
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────

DOCS_DIR = Path(__file__).parent.parent / "docs"
CHROMA_DIR = Path(__file__).parent.parent / ".chromadb"
COLLECTION_NAME = "incident_knowledge_base"
EMBEDDING_MODEL = "models/text-embedding-004"
CHUNK_SIZE = 600       # characters per chunk
CHUNK_OVERLAP = 100    # overlap between chunks
TOP_K = 5              # number of documents to retrieve

# ── Globals ──────────────────────────────────────────────────────────────────

_chroma_client: chromadb.PersistentClient | None = None
_collection: chromadb.Collection | None = None


# ── Embedding ────────────────────────────────────────────────────────────────

def _embed(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts using Google text-embedding-004."""
    result = genai.embed_content(
        model=EMBEDDING_MODEL,
        content=texts,
        task_type="retrieval_document",
    )
    return result["embedding"]


def _embed_query(text: str) -> list[float]:
    """Embed a single query string."""
    result = genai.embed_content(
        model=EMBEDDING_MODEL,
        content=text,
        task_type="retrieval_query",
    )
    return result["embedding"]


# ── Chunking ─────────────────────────────────────────────────────────────────

def _chunk_text(text: str, source: str) -> list[dict]:
    """
    Split text into overlapping chunks. Tries to split on paragraph
    boundaries first to preserve context.
    """
    # Split on double newlines (paragraph boundaries)
    paragraphs = re.split(r"\n{2,}", text)
    chunks = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(current) + len(para) <= CHUNK_SIZE:
            current += ("\n\n" if current else "") + para
        else:
            if current:
                chunks.append(current)
                # Keep last CHUNK_OVERLAP characters as overlap
                current = current[-CHUNK_OVERLAP:] + "\n\n" + para
            else:
                # Single paragraph longer than chunk size — split by sentences
                sentences = re.split(r"(?<=[.!?])\s+", para)
                for sentence in sentences:
                    if len(current) + len(sentence) <= CHUNK_SIZE:
                        current += (" " if current else "") + sentence
                    else:
                        if current:
                            chunks.append(current)
                        current = sentence

    if current:
        chunks.append(current)

    return [
        {
            "text": chunk,
            "source": source,
            "chunk_id": hashlib.md5(chunk.encode()).hexdigest()[:12],
        }
        for chunk in chunks
        if len(chunk.strip()) > 50  # Skip very short chunks
    ]


# ── Indexing ─────────────────────────────────────────────────────────────────

def _load_documents() -> list[dict]:
    """Load all .md files from the docs directory and chunk them."""
    all_chunks = []
    if not DOCS_DIR.exists():
        logger.warning(f"Docs directory not found: {DOCS_DIR}")
        return []

    md_files = list(DOCS_DIR.glob("*.md"))
    logger.info(f"Loading {len(md_files)} documentation files from {DOCS_DIR}")

    for md_file in md_files:
        content = md_file.read_text(encoding="utf-8")
        source = md_file.stem.replace("_", " ").title()
        chunks = _chunk_text(content, source)
        all_chunks.extend(chunks)
        logger.info(f"  {md_file.name}: {len(chunks)} chunks")

    logger.info(f"Total chunks to index: {len(all_chunks)}")
    return all_chunks


def initialize_rag() -> None:
    """
    Initialize ChromaDB and index documents if not already done.
    Called once at application startup.
    """
    global _chroma_client, _collection

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY not set — RAG cannot initialize.")
    genai.configure(api_key=api_key)

    # Persistent ChromaDB stored in prototype/.chromadb/
    CHROMA_DIR.mkdir(exist_ok=True)
    _chroma_client = chromadb.PersistentClient(
        path=str(CHROMA_DIR),
        settings=Settings(anonymized_telemetry=False),
    )

    # Check if collection already exists and is up to date
    existing = [c.name for c in _chroma_client.list_collections()]
    chunks = _load_documents()

    if COLLECTION_NAME in existing:
        _collection = _chroma_client.get_collection(COLLECTION_NAME)
        existing_count = _collection.count()
        logger.info(
            f"ChromaDB collection '{COLLECTION_NAME}' already exists "
            f"({existing_count} chunks). Checking for updates…"
        )
        # Re-index if doc count differs (simple staleness check)
        if existing_count == len(chunks):
            logger.info("Collection is up to date. Skipping re-indexing.")
            return
        logger.info("Doc count changed — re-indexing collection.")
        _chroma_client.delete_collection(COLLECTION_NAME)

    logger.info(f"Creating ChromaDB collection '{COLLECTION_NAME}'…")
    _collection = _chroma_client.create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )

    if not chunks:
        logger.warning("No documentation chunks found. RAG will return empty results.")
        return

    # Embed in batches of 20 (Google API limit per call is higher but we stay safe)
    BATCH_SIZE = 20
    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i : i + BATCH_SIZE]
        texts = [c["text"] for c in batch]
        embeddings = _embed(texts)

        _collection.add(
            ids=[f"{c['source']}_{c['chunk_id']}" for c in batch],
            embeddings=embeddings,
            documents=texts,
            metadatas=[{"source": c["source"]} for c in batch],
        )
        logger.info(f"  Indexed chunks {i + 1}–{min(i + BATCH_SIZE, len(chunks))}")

    logger.info(f"RAG initialization complete. {len(chunks)} chunks indexed.")


# ── Query ─────────────────────────────────────────────────────────────────────

def query_knowledge_base(query: str, top_k: int = TOP_K) -> list[dict]:
    """
    Perform semantic search over the indexed documentation.

    Args:
        query: Natural language query (e.g., alert description + service name)
        top_k: Number of top results to return

    Returns:
        List of dicts with keys: 'source', 'content', 'distance'
    """
    if _collection is None:
        logger.error("RAG collection not initialized. Call initialize_rag() first.")
        return []

    query_embedding = _embed_query(query)
    results = _collection.query(
        query_embeddings=[query_embedding],
        n_results=min(top_k, _collection.count()),
        include=["documents", "metadatas", "distances"],
    )

    docs = []
    for doc, meta, dist in zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    ):
        docs.append(
            {
                "source": meta.get("source", "Unknown"),
                "content": doc,
                "distance": round(dist, 4),
            }
        )

    return docs


def get_collection_stats() -> dict:
    """Return stats about the current ChromaDB collection."""
    if _collection is None:
        return {"status": "not_initialized", "count": 0}
    return {
        "status": "ready",
        "collection": COLLECTION_NAME,
        "document_count": _collection.count(),
        "docs_directory": str(DOCS_DIR),
    }
