"""Read-only retrieval from the knowledge-base API, with source provenance."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import httpx
from pydantic import BaseModel, ValidationError

from agent_core.citations import SourceLedger, current_ledger
from agent_core.tools.base import Tool, ToolResult

if TYPE_CHECKING:
    from agent_core.config import Settings
    from agent_core.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

HOW_TO_CITE = (
    "Put a result's cite value, e.g. [KB1], right after each statement it "
    "supports. Use only cite values you received."
)


class SearchResult(BaseModel):
    text: str
    score: float
    doc_id: str
    title: str
    section_path: list[str]
    author: str
    doc_date: str
    chunk_index: int
    # Absent from RAG servers that predate file names; the title stands in.
    file_name: str | None = None


class SearchResponse(BaseModel):
    results: list[SearchResult]
    embedding_model: str
    collection: str


class SearchKnowledgeBaseTool(Tool):
    name = "search_knowledge_base"
    description = (
        "Search technical documentation and runbooks for the incident's symptoms, "
        "services or error messages. Returns excerpts with a cite key, file name and "
        "section. Use them as reference material, then verify against live telemetry."
    )
    parameters_schema = {
        "type": "object",
        "properties": {"query": {"type": "string", "minLength": 1, "maxLength": 2000}},
        "required": ["query"],
        "additionalProperties": False,
    }

    def __init__(
        self, base_url: str, *, token: str | None = None,
        top_k: int = 5, timeout: float = 30,
    ) -> None:
        self.url = base_url.strip().rstrip("/") + "/api/search"
        self.token = token
        self.top_k = top_k
        self.timeout = timeout

    async def execute(self, query: str) -> ToolResult:
        if not isinstance(query, str) or not query.strip() or len(query) > 2000:
            return ToolResult(success=False, error="query must contain 1–2000 characters.")
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        try:
            # Bound total elapsed time as well as individual HTTP operations.
            async with asyncio.timeout(self.timeout):
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(
                        self.url, headers=headers,
                        json={"query": query.strip(), "top_k": self.top_k},
                    )
                    response.raise_for_status()
                    payload = SearchResponse.model_validate(response.json())
        except (TimeoutError, httpx.TimeoutException):
            return ToolResult(success=False, error="Knowledge-base search timed out.")
        except httpx.HTTPStatusError as exc:
            # Do not echo remote bodies, URLs or credentials into the LLM context.
            return ToolResult(success=False, error=f"Knowledge-base API returned HTTP {exc.response.status_code}.")
        except httpx.RequestError:
            return ToolResult(success=False, error="Knowledge-base API is unreachable.")
        except (ValueError, ValidationError):
            return ToolResult(success=False, error="Knowledge-base API returned an invalid search response.")

        # Outside a citation scope (tests, ad-hoc use) a throwaway ledger
        # still gives the model keys to cite; they just resolve to nothing.
        ledger = current_ledger()
        if ledger is None:
            ledger = SourceLedger()
        logger.debug(
            "Knowledge-base search used embedding_model=%s collection=%s",
            payload.embedding_model, payload.collection,
        )
        results = []
        for hit in payload.results[:self.top_k]:
            key = ledger.register(hit)
            logger.debug("Search hit [%s] = doc_id=%s chunk_index=%d", key, hit.doc_id, hit.chunk_index)
            # No doc_id or chunk_index here: the model cites the short key and
            # the ledger maps it back, so it never has to copy an id.
            results.append({
                "cite": f"[{key}]",
                "file": hit.file_name or hit.title,
                "title": hit.title,
                "section": " > ".join(hit.section_path),
                "author": hit.author,
                "doc_date": hit.doc_date,
                "score": hit.score,
                # Runbook code blocks can exceed the server's normal chunk budget.
                "text": hit.text[:4000],
                "truncated": len(hit.text) > 4000,
            })
        return ToolResult(success=True, data={"how_to_cite": HOW_TO_CITE, "results": results})


def register_rag_tool(registry: ToolRegistry, settings: Settings) -> None:
    if settings.rag_api_url.strip():
        registry.register(SearchKnowledgeBaseTool(
            settings.rag_api_url, token=settings.rag_api_token,
            top_k=settings.rag_top_k, timeout=settings.rag_timeout_seconds,
        ))
