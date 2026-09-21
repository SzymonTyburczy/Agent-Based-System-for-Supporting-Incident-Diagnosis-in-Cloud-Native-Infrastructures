import pytest

from app.config import Settings
from app.rag.embeddings import build_embedder


def cosine(a: list[float], b: list[float]) -> float:
    # Wektory są znormalizowane L2, więc iloczyn skalarny == cosine similarity.
    return sum(x * y for x, y in zip(a, b, strict=True))


@pytest.mark.slow
def test_related_texts_closer_than_unrelated():
    embedder = build_embedder(Settings())

    documents = embedder.embed_documents(
        [
            "Pod aplikacji restartuje się w pętli CrashLoopBackOff w klastrze Kubernetes.",
            "Przepis na sernik: zmiksuj twaróg z cukrem i jajkami, piecz 60 minut.",
        ]
    )
    query = embedder.embed_query("pod ciągle się restartuje, jak zdiagnozować przyczynę?")

    assert cosine(query, documents[0]) > cosine(query, documents[1])
