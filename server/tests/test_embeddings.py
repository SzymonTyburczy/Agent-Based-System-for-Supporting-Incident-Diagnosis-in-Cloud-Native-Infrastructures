import json
import math

import httpx
import pytest
from langchain_core.embeddings import Embeddings

from app.config import Settings
from app.rag import embeddings as embeddings_module
from app.rag.embeddings import (
    LangChainProvider,
    OpenAICompatibleEmbeddings,
    build_embedder,
    l2_normalize,
)


class StubInner(Embeddings):
    """Text-dependent vectors, deliberately not normalized, for testing the adapter."""

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


def test_empty_instruction_leaves_the_query_unchanged():
    stub = StubInner()
    provider = LangChainProvider(stub, model_id="stub", query_instruction="")
    provider.embed_query("hello")
    assert stub.query_calls[-1] == "hello"


def api_client(handler) -> OpenAICompatibleEmbeddings:
    return OpenAICompatibleEmbeddings(
        model="text-embedding-3-small",
        base_url="https://api.example.test/v1",
        api_key="test-key",
        transport=httpx.MockTransport(handler),
    )


def test_api_client_sends_the_openai_request_and_keeps_the_input_order():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        # Out of order on purpose: the rows belong to the inputs by index.
        rows = [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}]
        return httpx.Response(200, json={"data": rows})

    vectors = api_client(handler).embed_documents(["first", "second"])

    assert vectors == [[1.0, 0.0], [0.0, 1.0]]
    [request] = requests
    assert request.method == "POST"
    assert str(request.url) == "https://api.example.test/v1/embeddings"
    assert request.headers["Authorization"] == "Bearer test-key"
    assert json.loads(request.content) == {
        "model": "text-embedding-3-small",
        "input": ["first", "second"],
    }


def test_api_client_raises_on_an_error_status():
    client = api_client(lambda request: httpx.Response(401, json={"error": {"message": "no"}}))

    with pytest.raises(httpx.HTTPStatusError):
        client.embed_query("hello")


def test_api_client_sends_nothing_for_no_texts():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request expected")

    assert api_client(handler).embed_documents([]) == []


class RecordingEngine(StubInner):
    """Stands in for both engines and remembers how build_embedder created it."""

    def __init__(self, **kwargs) -> None:
        super().__init__()
        self.kwargs = kwargs


def patch_engines(monkeypatch) -> dict[str, list[RecordingEngine]]:
    created: dict[str, list[RecordingEngine]] = {"api": [], "ollama": []}

    def factory(kind: str):
        def make(**kwargs) -> RecordingEngine:
            engine = RecordingEngine(**kwargs)
            created[kind].append(engine)
            return engine

        return make

    monkeypatch.setattr(embeddings_module, "OpenAICompatibleEmbeddings", factory("api"))
    monkeypatch.setattr(embeddings_module, "OllamaEmbeddings", factory("ollama"))
    return created


def test_without_an_api_key_embeddings_come_from_ollama(monkeypatch):
    monkeypatch.delenv("IDAR_EMBEDDING_API_KEY", raising=False)
    created = patch_engines(monkeypatch)

    settings = Settings(_env_file=None)
    embedder = build_embedder(settings)
    embedder.embed_query("hello")

    assert created["api"] == []
    [ollama] = created["ollama"]
    assert ollama.kwargs == {"model": settings.embedding_model, "base_url": settings.ollama_url}
    assert embedder.model_id == settings.embedding_model
    assert ollama.query_calls[-1].startswith("Instruct: ")


def test_an_api_key_switches_embeddings_to_the_api(monkeypatch):
    created = patch_engines(monkeypatch)

    settings = Settings(_env_file=None, embedding_api_key="test-key")
    embedder = build_embedder(settings)
    embedder.embed_query("hello")

    assert created["ollama"] == []
    [api] = created["api"]
    assert api.kwargs == {
        "model": settings.embedding_api_model,
        "base_url": settings.embedding_api_url,
        "api_key": "test-key",
    }
    assert embedder.model_id == settings.embedding_api_model
    # text-embedding-3 takes no instruction; the Qwen3 one is for Ollama only.
    assert api.query_calls[-1] == "hello"


def test_a_failed_api_probe_names_the_api_but_never_the_key(monkeypatch):
    class Unreachable(StubInner):
        def __init__(self, **kwargs) -> None:
            super().__init__()

        def embed_query(self, text: str) -> list[float]:
            raise httpx.ConnectError("unreachable")

    monkeypatch.setattr(embeddings_module, "OpenAICompatibleEmbeddings", Unreachable)

    settings = Settings(_env_file=None, embedding_api_key="sk-secret-value")
    with pytest.raises(RuntimeError) as error:
        build_embedder(settings)

    message = str(error.value)
    assert settings.embedding_api_model in message
    assert settings.embedding_api_url in message
    assert "sk-secret-value" not in message
