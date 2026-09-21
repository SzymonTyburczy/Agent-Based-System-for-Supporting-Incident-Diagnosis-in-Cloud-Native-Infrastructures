import math

from langchain_core.embeddings import Embeddings

from app.rag.embeddings import LangChainProvider, l2_normalize


class StubInner(Embeddings):
    """Wektory zależne od tekstu, celowo nieznormalizowane — do testów adaptera."""

    def __init__(self) -> None:
        self.query_calls: list[str] = []

    def _vec(self, text: str) -> list[float]:
        return [float(len(text)), float(sum(text.encode()) % 97), 2.0]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        self.query_calls.append(text)
        return self._vec(text)


def make_provider() -> tuple[LangChainProvider, StubInner]:
    stub = StubInner()
    provider = LangChainProvider(stub, model_id="stub", query_instruction="test task")
    return provider, stub


def norm(vector: list[float]) -> float:
    return math.sqrt(sum(x * x for x in vector))


def test_l2_normalize_returns_unit_vector():
    assert math.isclose(norm(l2_normalize([3.0, 4.0])), 1.0)


def test_l2_normalize_keeps_zero_vector():
    assert l2_normalize([0.0, 0.0]) == [0.0, 0.0]


def test_dimension_probed_from_inner():
    provider, _ = make_provider()
    assert provider.dimension == 3


def test_query_gets_instruction_prefix():
    provider, stub = make_provider()
    provider.embed_query("hello")
    assert stub.query_calls[-1] == "Instruct: test task\nQuery: hello"


def test_documents_get_no_prefix_so_embeddings_differ_from_query():
    provider, _ = make_provider()
    query_vector = provider.embed_query("hello")
    document_vector = provider.embed_documents(["hello"])[0]
    assert query_vector != document_vector


def test_documents_and_queries_are_normalized():
    provider, _ = make_provider()
    assert math.isclose(norm(provider.embed_documents(["some text"])[0]), 1.0)
    assert math.isclose(norm(provider.embed_query("some text")), 1.0)
