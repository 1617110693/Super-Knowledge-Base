"""
MCP Server for Local Knowledge Base.

Provides tools for AI agents (Claude Code, etc.) to search, query,
and retrieve documents from knowledge bases via stdio transport.

Usage:
    uv run local-kb-mcp                     # Local dev
    uvx --from . local-kb-mcp               # From local dir
    uvx --from git+https://... local-kb-mcp # From repo

Configuration via environment variables:
    KNOWLEDGE_BASE_DATA_DIR  — Path to app data directory (required)
    EMBEDDING_API_BASE       — OpenAI-compatible embedding API base URL
    EMBEDDING_API_KEY        — Embedding API key
    EMBEDDING_MODEL          — Embedding model name
    RERANK_API_BASE          — Rerank API base URL
    RERANK_API_KEY           — Rerank API key
    RERANK_MODEL             — Rerank model name
    LLM_API_BASE             — LLM API base URL (for ask_question)
    LLM_API_KEY              — LLM API key
    LLM_MODEL                — LLM model name
"""

import json
import os
from pathlib import Path
from typing import Literal, Optional

from fastmcp import FastMCP

from .lancedb_client import LanceDBSearcher

# ── Configuration ──

DATA_DIR = os.environ.get("KNOWLEDGE_BASE_DATA_DIR", "")
if not DATA_DIR:
    # Default: ~/.local-knowledge-base
    default_dir = Path.home() / ".local-knowledge-base"
    if default_dir.exists():
        DATA_DIR = str(default_dir)
    else:
        DATA_DIR = str(default_dir)  # Use anyway; will be created by the desktop app

EMBEDDING_API_BASE = os.environ.get(
    "EMBEDDING_API_BASE", "https://api.openai.com"
)
EMBEDDING_API_KEY = os.environ.get("EMBEDDING_API_KEY", "")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")
RERANK_API_BASE = os.environ.get("RERANK_API_BASE", "https://api.jina.ai")
RERANK_API_KEY = os.environ.get("RERANK_API_KEY", "")
RERANK_MODEL = os.environ.get(
    "RERANK_MODEL", "jina-reranker-v2-base-multilingual"
)
LLM_API_BASE = os.environ.get("LLM_API_BASE", "https://api.openai.com")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")

# ── MCP Server ──

mcp = FastMCP(name="Local Knowledge Base")


def _get_searcher() -> LanceDBSearcher:
    """Create a LanceDB searcher with current config."""
    if not DATA_DIR:
        raise ValueError(
            "KNOWLEDGE_BASE_DATA_DIR is not set. "
            "Set it to the app data directory containing lancedb_data/."
        )
    return LanceDBSearcher(
        data_dir=Path(DATA_DIR) / "lancedb_data",
        embedding_api_base=EMBEDDING_API_BASE,
        embedding_api_key=EMBEDDING_API_KEY,
        embedding_model=EMBEDDING_MODEL,
        rerank_api_base=RERANK_API_BASE,
        rerank_api_key=RERANK_API_KEY,
        rerank_model=RERANK_MODEL,
    )


@mcp.tool
def search_knowledge_base(
    query: str,
    kb_id: str,
    top_k: int = 10,
    search_type: Literal["hybrid", "vector", "fts"] = "hybrid",
    rerank: bool = True,
    doc_id_filter: Optional[str] = None,
) -> list[dict]:
    """
    Search a knowledge base for chunks matching the query.

    Performs hybrid search (dense vector + BM25 keyword) with optional
    reranking. Returns the most relevant document chunks with scores
    and metadata.

    Args:
        query: The search query text.
        kb_id: UUID of the knowledge base to search.
        top_k: Number of results to return (1-100, default 10).
        search_type: 'hybrid' combines vector + keyword, 'vector' for
                     semantic only, 'fts' for keyword only.
        rerank: Whether to apply reranking model to refine results.
        doc_id_filter: Optional document UUID to restrict search scope.

    Returns:
        List of chunks with chunk_id, doc_id, doc_name, content, score, metadata.
    """
    searcher = _get_searcher()
    try:
        results = searcher.search(
            query=query,
            kb_id=kb_id,
            top_k=min(top_k, 100),
            search_type=search_type,
            rerank=rerank,
            doc_id_filter=doc_id_filter,
        )
        return results
    finally:
        searcher.close()


@mcp.tool
def list_knowledge_bases() -> list[dict]:
    """
    List all available knowledge bases with their metadata.

    Returns name, id, document count, and chunk count for each knowledge base.

    Returns:
        List of knowledge base summaries.
    """
    if not DATA_DIR:
        return []
    searcher = _get_searcher()
    try:
        return searcher.list_kbs()
    finally:
        searcher.close()


@mcp.tool
def get_document(
    kb_id: str,
    doc_id: str,
    include_chunks: bool = False,
) -> dict:
    """
    Retrieve a document's full content and metadata from a knowledge base.

    Returns the complete document text reconstructed from chunks, plus metadata.
    Optionally includes individual chunk details.

    Args:
        kb_id: UUID of the knowledge base.
        doc_id: UUID of the document to retrieve.
        include_chunks: If True, return all chunks with their embeddings metadata.

    Returns:
        Document object with id, name, content (full text), and optionally chunks.
    """
    searcher = _get_searcher()
    try:
        return searcher.get_document(kb_id, doc_id, include_chunks)
    finally:
        searcher.close()


@mcp.tool
def ask_question(
    kb_id: str,
    question: str,
    top_k: int = 5,
    include_sources: bool = True,
) -> dict:
    """
    Ask a question and get an answer based on the knowledge base content.

    Performs retrieval-augmented generation (RAG): searches for relevant
    chunks, builds a prompt with context, and generates an answer using
    the configured LLM.

    Requires LLM_API_KEY to be configured for answer generation.

    Args:
        kb_id: UUID of the knowledge base to query.
        question: The question to answer.
        top_k: Number of source chunks to retrieve (1-20, default 5).
        include_sources: Whether to include source citations in the response.

    Returns:
        Dict with 'answer' (string) and optionally 'sources' (list of chunks).
    """
    if not LLM_API_KEY:
        return {
            "answer": "LLM is not configured. Set LLM_API_KEY to enable Q&A. "
            "Use search_knowledge_base to find relevant chunks manually.",
            "sources": [],
        }

    searcher = _get_searcher()
    try:
        # Search for relevant chunks
        results = searcher.search(
            query=question,
            kb_id=kb_id,
            top_k=min(top_k, 20),
            search_type="hybrid",
            rerank=True,
        )

        if not results:
            return {
                "answer": "No relevant information found in the knowledge base.",
                "sources": [],
            }

        # Build context
        context = "\n\n---\n\n".join(
            [f"[Source: {r['doc_name']}]\n{r['content']}" for r in results]
        )

        # Call LLM
        answer = searcher.generate_answer(
            question=question,
            context=context,
            llm_api_base=LLM_API_BASE,
            llm_api_key=LLM_API_KEY,
            llm_model=LLM_MODEL,
        )

        response = {"answer": answer}
        if include_sources:
            response["sources"] = results
        return response
    finally:
        searcher.close()


def main():
    """Entry point for `local-kb-mcp` command."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
