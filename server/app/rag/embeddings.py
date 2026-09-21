import math
from typing import Protocol

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


class LangChainProvider:
    """Adapter na dowolną integrację LangChain Embeddings, dokładający reguły
    wspólne dla wszystkich silników:

    - prefiks instrukcji wyłącznie dla zapytań, nigdy dla dokumentów
      (asymetria wymagana przez Qwen3-Embedding),
    - normalizację L2 (nie zakładamy, że silnik normalizuje sam),
    - sondę wymiaru przy konstrukcji (świadomie: awaria połączenia z silnikiem
      ujawnia się przy starcie aplikacji, nie przy pierwszym żądaniu).
    """

    def __init__(self, inner: Embeddings, model_id: str, query_instruction: str) -> None:
        self._inner = inner
        self._instruction = query_instruction
        self.model_id = model_id
        self.dimension = len(inner.embed_query("dimension probe"))

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [l2_normalize(v) for v in self._inner.embed_documents(texts)]

    def embed_query(self, text: str) -> list[float]:
        prefixed = f"Instruct: {self._instruction}\nQuery: {text}"
        return l2_normalize(self._inner.embed_query(prefixed))


def build_embedder(settings: Settings) -> EmbeddingProvider:
    inner = OllamaEmbeddings(model=settings.embedding_model, base_url=settings.ollama_url)
    try:
        return LangChainProvider(
            inner,
            model_id=settings.embedding_model,
            query_instruction=settings.query_instruction,
        )
    except Exception as err:
        raise RuntimeError(
            f"Embedding provider startup probe failed for model "
            f"'{settings.embedding_model}' at {settings.ollama_url}. "
            f"Is Ollama running and the model pulled "
            f"(ollama pull {settings.embedding_model})?"
        ) from err
