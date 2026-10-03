"""Read-only retrieval from the knowledge-base API, with source provenance."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import httpx
from pydantic import BaseModel, ValidationError

from agent_core.tools.base import Tool, ToolResult

if TYPE_CHECKING:
    from agent_core.config import Settings
    from agent_core.tools.registry import ToolRegistry


class SearchResult(BaseModel):
    text: str
    score: float
    doc_id: str
    title: str
    section_path: list[str]
    author: str
    doc_date: str
    chunk_index: int


class SearchResponse(BaseModel):
    results: list[SearchResult]
    embedding_model: str
    collection: str


class SearchKnowledgeBaseTool(Tool):
    name = "search_knowledge_base"
    description = (
        "Search technical documentation and runbooks for the incident's symptoms, "
        "services or error messages. Returns excerpts with document IDs and section "
        "paths. Use them as reference material, then verify against live telemetry."
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

        results = []
        for hit in payload.results[:self.top_k]:
            item = hit.model_dump()
            # Runbook code blocks can exceed the server's normal chunk budget.
            item["text"] = hit.text[:4000]
            item["truncated"] = len(hit.text) > 4000
            results.append(item)
        return ToolResult(success=True, data={
            "results": results,
            "embedding_model": payload.embedding_model,
            "collection": payload.collection,
        })


def register_rag_tool(registry: ToolRegistry, settings: Settings) -> None:
    if settings.rag_api_url.strip():
        registry.register(SearchKnowledgeBaseTool(
            settings.rag_api_url, token=settings.rag_api_token,
            top_k=settings.rag_top_k, timeout=settings.rag_timeout_seconds,
        ))
