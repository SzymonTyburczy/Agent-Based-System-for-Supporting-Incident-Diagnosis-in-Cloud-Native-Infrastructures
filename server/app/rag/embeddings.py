import math
from typing import Protocol

import httpx
from langchain_core.embeddings import Embeddings
from langchain_ollama import OllamaEmbeddings

from app.config import Settings


class EmbeddingProvider(Protocol):
    model_id: str
    dimension: int

    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


def l2_normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vector))
    if norm == 0.0:
        return list(vector)
    return [x / norm for x in vector]


class OpenAICompatibleEmbeddings(Embeddings):
    """`POST {base_url}/embeddings` as OpenAI defines it, which other providers
    (and Ollama under /v1) also serve. The ingest pipeline already sends batches
    of 32 chunks, well under the API's per-request limits."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._model = model
        self._client = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=60.0,
            transport=transport,
        )

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        response = self._client.post("/embeddings", json={"model": self._model, "input": texts})
        response.raise_for_status()
        rows = sorted(response.json()["data"], key=lambda row: row["index"])
        return [row["embedding"] for row in rows]

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


class LangChainProvider:
    """Adapter over any LangChain Embeddings integration that adds the rules
    shared by every engine:

    - the instruction prefix, when the model takes one, for queries only and
      never for documents (the asymmetry Qwen3-Embedding requires),
    - L2 normalization (we do not assume the engine normalizes on its own),
    - a dimension probe at construction (on purpose: a broken connection to the
      engine shows up at application startup, not on the first request).
    """

    def __init__(self, inner: Embeddings, model_id: str, query_instruction: str) -> None:
        self._inner = inner
        self._instruction = query_instruction
        self.model_id = model_id
        self.dimension = len(inner.embed_query("dimension probe"))

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [l2_normalize(v) for v in self._inner.embed_documents(texts)]

    def embed_query(self, text: str) -> list[float]:
        if self._instruction:
            text = f"Instruct: {self._instruction}\nQuery: {text}"
        return l2_normalize(self._inner.embed_query(text))


def build_embedder(settings: Settings) -> EmbeddingProvider:
    """The embedding API when IDAR_EMBEDDING_API_KEY is set, Ollama otherwise."""
    if settings.embedding_api_key:
        inner: Embeddings = OpenAICompatibleEmbeddings(
            model=settings.embedding_api_model,
            base_url=settings.embedding_api_url,
            api_key=settings.embedding_api_key,
        )
        model_id, instruction = settings.embedding_api_model, ""
        location = settings.embedding_api_url
        hint = "Is IDAR_EMBEDDING_API_KEY valid for this API, and does it serve the model?"
    else:
        inner = OllamaEmbeddings(model=settings.embedding_model, base_url=settings.ollama_url)
        model_id, instruction = settings.embedding_model, settings.query_instruction
        location = settings.ollama_url
        hint = f"Is Ollama running and the model pulled (ollama pull {model_id})?"
    try:
        return LangChainProvider(inner, model_id=model_id, query_instruction=instruction)
    except Exception as err:
        raise RuntimeError(
            f"Embedding provider startup probe failed for model '{model_id}' at {location}. {hint}"
        ) from err
