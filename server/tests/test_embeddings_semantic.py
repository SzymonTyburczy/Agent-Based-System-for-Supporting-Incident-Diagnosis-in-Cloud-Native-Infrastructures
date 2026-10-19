import pytest

from app.config import Settings
from app.rag.embeddings import build_embedder


def cosine(a: list[float], b: list[float]) -> float:
    # The vectors are L2-normalized, so the dot product is the cosine similarity.
    return sum(x * y for x, y in zip(a, b, strict=True))


@pytest.mark.slow
@pytest.mark.parametrize(
    ("related", "unrelated", "question"),
    [
        (
            "The application pod restarts in a CrashLoopBackOff loop in the Kubernetes cluster.",
            "Cheesecake recipe: blend curd cheese with sugar and eggs, bake for 60 minutes.",
            "the pod keeps restarting, how do I diagnose the cause?",
        ),
        # Polish on purpose: documents in the knowledge base may be written in Polish.
        (
            "Pod aplikacji restartuje się w pętli CrashLoopBackOff w klastrze Kubernetes.",
            "Przepis na sernik: zmiksuj twaróg z cukrem i jajkami, piecz 60 minut.",
            "pod ciągle się restartuje, jak zdiagnozować przyczynę?",
        ),
    ],
    ids=["english", "polish"],
)
def test_related_texts_closer_than_unrelated(related: str, unrelated: str, question: str):
    embedder = build_embedder(Settings())

    documents = embedder.embed_documents([related, unrelated])
    query = embedder.embed_query(question)

    assert cosine(query, documents[0]) > cosine(query, documents[1])


@pytest.mark.slow
def test_api_path_against_an_openai_compatible_server():
    # Ollama serves the OpenAI embeddings API under /v1 and ignores the key, so
    # the API client runs end to end against a real server without a paid key.
    ollama = Settings()
    embedder = build_embedder(
        Settings(
            embedding_api_key="ignored-by-ollama",
            embedding_api_url=f"{ollama.ollama_url}/v1",
            embedding_api_model=ollama.embedding_model,
        )
    )

    documents = embedder.embed_documents(
        [
            "The application pod restarts in a CrashLoopBackOff loop in the Kubernetes cluster.",
            "Cheesecake recipe: blend curd cheese with sugar and eggs, bake for 60 minutes.",
        ]
    )
    query = embedder.embed_query("the pod keeps restarting, how do I diagnose the cause?")

    assert embedder.model_id == ollama.embedding_model
    assert len(query) == embedder.dimension
    assert cosine(query, documents[0]) > cosine(query, documents[1])
