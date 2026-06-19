"""
MCP Server for Local Knowledge Base.

Provides tools for AI agents (Claude Code, etc.) to search, query,
and retrieve documents from knowledge bases via stdio transport.

Usage:
    uv run local-kb-mcp                     # Local dev
    uvx --from . local-kb-mcp               # From local dir
    uvx --from git+https://... local-kb-mcp # From repo

Configuration:
    KNOWLEDGE_BASE_DATA_DIR  — Path to app data directory (required)
                              API keys are read from settings.json in this directory.
                              Environment variables can override individual values.
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
    default_dir = Path.home() / ".local-knowledge-base"
    if default_dir.exists():
        DATA_DIR = str(default_dir)
    else:
        DATA_DIR = str(default_dir)


def _load_settings() -> dict:
    """Load API settings from settings.json in the data directory."""
    settings_path = Path(DATA_DIR) / "settings.json"
    if settings_path.exists():
        try:
            with open(settings_path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


_settings = _load_settings()

# Env vars take precedence over settings.json values
EMBEDDING_API_BASE = os.environ.get("EMBEDDING_API_BASE") or _settings.get(
    "embedding_api_base", "https://api.openai.com/v1"
)
EMBEDDING_API_KEY = os.environ.get("EMBEDDING_API_KEY") or _settings.get("embedding_api_key", "")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL") or _settings.get(
    "embedding_model", "text-embedding-3-small"
)
RERANK_API_BASE = os.environ.get("RERANK_API_BASE") or _settings.get(
    "rerank_api_base", "https://api.jina.ai/v1"
)
RERANK_API_KEY = os.environ.get("RERANK_API_KEY") or _settings.get("rerank_api_key", "")
RERANK_MODEL = os.environ.get("RERANK_MODEL") or _settings.get(
    "rerank_model", "jina-reranker-v2-base-multilingual"
)

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

    Reads from knowledge_bases.json (the registry) and cross-references with
    LanceDB tables to get actual chunk counts. Orphaned LanceDB tables (not
    in the registry) are flagged for cleanup.

    Returns name, id, document count, and chunk count for each knowledge base.
    """
    if not DATA_DIR:
        return []

    # Load registry
    registry = _load_registry()
    registry_ids = {kb["id"] for kb in registry.get("knowledge_bases", [])}

    # Get LanceDB stats
    searcher = _get_searcher()
    try:
        lance_kbs = {kb["id"]: kb for kb in searcher.list_kbs()}
    finally:
        searcher.close()

    # Merge: registry KBs with LanceDB stats
    results = []
    for kb in registry.get("knowledge_bases", []):
        stats = lance_kbs.pop(kb["id"], {})
        results.append({
            "id": kb["id"],
            "name": kb["name"],
            "description": kb.get("description", ""),
            "document_count": stats.get("document_count", kb.get("document_count", 0)),
            "chunk_count": stats.get("chunk_count", kb.get("chunk_count", 0)),
            "created_at": kb.get("created_at", ""),
        })

    # Flag orphaned LanceDB tables (not in registry)
    for orphan_id, stats in lance_kbs.items():
        results.append({
            "id": orphan_id,
            "name": f"[ORPHAN TABLE] {orphan_id[:8]}...",
            "description": "Orphaned LanceDB table — no matching registry entry. Use delete_knowledge_base to clean up.",
            "document_count": stats.get("document_count", 0),
            "chunk_count": stats.get("chunk_count", 0),
            "created_at": "",
            "orphaned": True,
        })

    # Flag orphaned KB directories (on disk but not in registry)
    data_path = Path(DATA_DIR)
    for entry in data_path.iterdir():
        if entry.is_dir() and entry.name.startswith("kb_"):
            kb_id = entry.name.replace("kb_", "").replace("_", "-")
            if kb_id not in registry_ids and kb_id not in lance_kbs:
                results.append({
                    "id": kb_id,
                    "name": f"[ORPHAN DIR] {kb_id[:8]}...",
                    "description": "Orphaned KB directory — no registry entry or LanceDB table.",
                    "document_count": 0,
                    "chunk_count": 0,
                    "created_at": "",
                    "orphaned": True,
                })

    return results


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


# ── KB management helpers ──

def _load_registry() -> dict:
    """Load the knowledge base registry from knowledge_bases.json."""
    path = Path(DATA_DIR) / "knowledge_bases.json"
    if path.exists():
        try:
            with open(path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": 1, "knowledge_bases": []}


def _save_registry(registry: dict):
    """Save the knowledge base registry to knowledge_bases.json."""
    path = Path(DATA_DIR) / "knowledge_bases.json"
    with open(path, "w") as f:
        json.dump(registry, f, indent=2)


@mcp.tool
def create_knowledge_base(name: str, description: str = "") -> dict:
    """
    Create a new knowledge base.

    Args:
        name: Human-readable name for the knowledge base.
        description: Optional description of the knowledge base.

    Returns:
        The created knowledge base object with id, name, and metadata.
    """
    import uuid
    from datetime import datetime, timezone

    registry = _load_registry()
    kb = {
        "id": str(uuid.uuid4()),
        "name": name,
        "description": description,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "document_count": 0,
        "chunk_count": 0,
        "embedding_model": "",
        "embedding_dim": 0,
    }
    registry["knowledge_bases"].append(kb)
    _save_registry(registry)

    # Create KB directory
    kb_dir = Path(DATA_DIR) / f"kb_{kb['id']}"
    kb_dir.mkdir(parents=True, exist_ok=True)
    (kb_dir / "docs").mkdir(exist_ok=True)

    return kb


@mcp.tool
def delete_knowledge_base(kb_id: str) -> dict:
    """
    Delete a knowledge base and all its data (documents, vectors, chunks).

    Args:
        kb_id: UUID of the knowledge base to delete.

    Returns:
        Status object indicating success or error.
    """
    import shutil

    registry = _load_registry()
    original_count = len(registry["knowledge_bases"])
    registry["knowledge_bases"] = [
        kb for kb in registry["knowledge_bases"] if kb["id"] != kb_id
    ]
    if len(registry["knowledge_bases"]) == original_count:
        return {"status": "not_found", "detail": f"Knowledge base not found: {kb_id}"}

    _save_registry(registry)

    # Remove KB directory
    kb_dir = Path(DATA_DIR) / f"kb_{kb_id}"
    if kb_dir.exists():
        shutil.rmtree(kb_dir)

    # Drop LanceDB table
    table_name = f"kb_{kb_id.replace('-', '_')}"
    searcher = _get_searcher()
    try:
        if table_name in searcher.db.table_names():
            searcher.db.drop_table(table_name)
    finally:
        searcher.close()

    return {"status": "deleted", "kb_id": kb_id}


@mcp.tool
def rename_knowledge_base(kb_id: str, name: str) -> dict:
    """
    Rename a knowledge base.

    Args:
        kb_id: UUID of the knowledge base to rename.
        name: New name for the knowledge base.

    Returns:
        The updated knowledge base object, or an error.
    """
    from datetime import datetime, timezone

    registry = _load_registry()
    for kb in registry["knowledge_bases"]:
        if kb["id"] == kb_id:
            kb["name"] = name
            kb["updated_at"] = datetime.now(timezone.utc).isoformat()
            _save_registry(registry)
            return kb

    return {"status": "not_found", "detail": f"Knowledge base not found: {kb_id}"}


def main():
    """Entry point for `local-kb-mcp` command."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
