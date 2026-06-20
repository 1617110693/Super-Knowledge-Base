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
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastmcp import FastMCP

from .lancedb_client import LanceDBSearcher
from .mineru_client import (
    MinerUError,
    SUPPORTED_EXTENSIONS,
    is_supported,
    parse_document,
    parse_document_agent,
)

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
            with open(settings_path, encoding="utf-8") as f:
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
MINERU_TOKEN = os.environ.get("MINERU_TOKEN") or _settings.get("mineru_token", "")

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
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": 1, "knowledge_bases": []}


def _save_registry(registry: dict):
    """Save the knowledge base registry to knowledge_bases.json."""
    path = Path(DATA_DIR) / "knowledge_bases.json"
    with open(path, "w", encoding="utf-8") as f:
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
    # Probe embedding dimension so the KB shows the bound model from the start
    emb_dim = 0
    try:
        searcher = _get_searcher()
        emb_dim = _get_or_fetch_embedding_dim(searcher)
        searcher.close()
    except Exception:
        pass

    kb = {
        "id": str(uuid.uuid4()),
        "name": name,
        "description": description,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "document_count": 0,
        "chunk_count": 0,
        "embedding_model": EMBEDDING_MODEL,
        "embedding_dim": emb_dim,
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
def rename_knowledge_base(kb_id: str, name: str, description: str = "") -> dict:
    """
    Rename a knowledge base and optionally update its description.

    Args:
        kb_id: UUID of the knowledge base to rename.
        name: New name for the knowledge base.
        description: Optional new description (empty string = no change).

    Returns:
        The updated knowledge base object, or an error.
    """
    from datetime import datetime, timezone

    registry = _load_registry()
    for kb in registry["knowledge_bases"]:
        if kb["id"] == kb_id:
            kb["name"] = name
            if description:
                kb["description"] = description
            kb["updated_at"] = datetime.now(timezone.utc).isoformat()
            _save_registry(registry)
            return kb

    return {"status": "not_found", "detail": f"Knowledge base not found: {kb_id}"}


@mcp.tool
def add_document(
    kb_id: str,
    content: str = "",
    doc_name: str = "",
    doc_id: str = "",
    file_path: str = "",
    parse_timeout: int = 120,
) -> dict:
    """
    Add or update a document in a knowledge base.

    Two modes are supported:

    1. **Text mode** — pass *content* with the full text. The server
       chunks, embeds, and stores it directly.

    2. **File mode** — pass *file_path* to a local file (PDF, DOCX, PPTX,
       XLSX, images, HTML, etc.). The server parses it via MinerU's Precise
       API and indexes the resulting markdown. Requires that a MinerU token
       is configured in the desktop app's settings. Progress is logged to
       stderr so MCP clients can display it.

    If both *content* and *file_path* are provided, *file_path* takes
    precedence.

    If *doc_id* matches an existing document, old chunks are replaced
    (re-index).

    Args:
        kb_id: UUID of the target knowledge base.
        content: Full text content (text mode). Ignored if *file_path* is set.
        doc_name: Human-readable name. If empty, derived from the first
                  line of content or the file name.
        doc_id: Optional UUID. Generated if empty.
        file_path: Absolute path to a local file to parse and index.
        parse_timeout: Max seconds to wait for MinerU parsing (default 120).

    Returns:
        Document object with id, name, chunk_count, and status.
    """
    import sys as _sys
    import uuid
    from pathlib import Path as _Path

    if not DATA_DIR:
        return {"status": "error", "detail": "KNOWLEDGE_BASE_DATA_DIR is not set"}

    # ── Resolve content: file_path > raw content ──
    TEXT_EXTENSIONS = frozenset({".md", ".markdown", ".txt", ".csv", ".json", ".xml", ".yaml", ".yml", ".py", ".rs", ".ts", ".js", ".tsx", ".jsx", ".log"})

    if file_path:
        fp = _Path(file_path)
        if not fp.exists():
            return {"status": "error", "detail": f"File not found: {file_path}"}

        ext = fp.suffix.lower()

        if ext in TEXT_EXTENSIONS:
            # Read text files directly — no MinerU needed
            try:
                content = fp.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                try:
                    content = fp.read_text(encoding="gbk")
                except Exception:
                    return {"status": "error", "detail": f"Cannot decode file as UTF-8 or GBK: {file_path}"}
        elif is_supported(file_path):
            # Progress forwarded to stderr → MCP client logs
            def _progress(msg: str):
                print(f"[MinerU] {msg}", file=_sys.stderr, flush=True)

            content = None
            last_error = None
            size_mb = fp.stat().st_size / (1024 * 1024)

            # ── Strategy 1 (small files): Agent API ──
            # No token needed, uses native Office parsers, completes
            # in seconds.  Best for the common case.
            if size_mb <= 10:
                try:
                    content = parse_document_agent(
                        file_path,
                        timeout=parse_timeout,
                        progress=_progress,
                    )
                except MinerUError as exc:
                    last_error = str(exc)
                    _progress(f"Agent API failed: {exc}")

            # ── Strategy 2 (large files or Agent API failed): Precise API ──
            if content is None:
                if not MINERU_TOKEN:
                    return {
                        "status": "error",
                        "detail": (
                            "MinerU token is not configured and Agent API "
                            f"failed ({last_error or 'file too large'}). "
                            "Set a token in the desktop app's Settings page "
                            "for large-file support."
                        ),
                    }
                try:
                    content = parse_document(
                        file_path, MINERU_TOKEN,
                        timeout=parse_timeout,
                        progress=_progress,
                    )
                except MinerUError as exc:
                    return {"status": "error", "detail": str(exc)}
        else:
            return {
                "status": "error",
                "detail": (
                    f"Unsupported file type: {ext}. "
                    f"Text formats: {', '.join(sorted(TEXT_EXTENSIONS))}. "
                    f"MinerU formats: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
                ),
            }

    if not content.strip():
        return {"status": "error", "detail": "No content provided (both content and file_path are empty)"}

    # ── Resolve doc_id and doc_name ──
    if not doc_id:
        doc_id = str(uuid.uuid4())
    if not doc_name:
        if file_path:
            doc_name = _Path(file_path).stem
        else:
            for line in content.strip().split("\n"):
                name = line.strip().lstrip("# ").strip()
                if name:
                    doc_name = name[:120]
                    break
        if not doc_name:
            doc_name = doc_id[:8]

    searcher = _get_searcher()
    try:
        searcher.ensure_table(kb_id, _get_or_fetch_embedding_dim(searcher))
        result = searcher.add_document(
            kb_id=kb_id,
            doc_id=doc_id,
            doc_name=doc_name,
            content=content,
        )
    finally:
        searcher.close()

    if result.get("status") == "indexed":
        _sync_doc_to_desktop(
            kb_id, doc_id, doc_name,
            file_path if file_path else "",
            content,
            result["chunk_count"],
        )

    return result


@mcp.tool
def delete_document(kb_id: str, doc_id: str) -> dict:
    """
    Delete a document and all its chunks from a knowledge base.

    Args:
        kb_id: UUID of the knowledge base.
        doc_id: UUID of the document to delete.

    Returns:
        Status object indicating success or error.
    """
    if not DATA_DIR:
        return {"status": "error", "detail": "KNOWLEDGE_BASE_DATA_DIR is not set"}

    searcher = _get_searcher()
    try:
        result = searcher.delete_document(kb_id, doc_id)
    finally:
        searcher.close()

    # Remove from KB docs directory
    if result.get("status") == "deleted":
        _remove_doc_from_desktop(kb_id, doc_id)

    return result


# ── Registry helpers ──

_embedding_dim_cache: dict[str, int] = {}


def _get_or_fetch_embedding_dim(searcher) -> int:
    """Get the embedding dimension, caching it per model."""
    if EMBEDDING_MODEL in _embedding_dim_cache:
        return _embedding_dim_cache[EMBEDDING_MODEL]

    # Fetch via a single-text embedding call
    try:
        vec = searcher._embed(["dimension probe"])
        dim = len(vec[0])
        _embedding_dim_cache[EMBEDDING_MODEL] = dim
        return dim
    except Exception:
        # Fallback to common default
        return 1024


def _sync_doc_to_desktop(
    kb_id: str,
    doc_id: str,
    doc_name: str,
    file_path: str,
    content: str,
    chunk_count: int,
):
    """Write document metadata in the format the desktop app expects.

    Desktop app structure::

        kb_{kb_id}/
          docs/
            {doc_id}/
              metadata.json   ← Document struct as JSON
              full.md         ← parsed markdown

    Also updates ``knowledge_bases.json`` so the KB list stays in sync.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    kb_dir = Path(DATA_DIR) / f"kb_{kb_id}"
    doc_dir = kb_dir / "docs" / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)

    # Determine file_type and file_size from the original file
    ext = Path(file_path).suffix.lstrip(".") if file_path else "txt"
    file_size = 0
    if file_path:
        try:
            file_size = Path(file_path).stat().st_size
        except OSError:
            pass

    # Load/create metadata.json
    meta_path = doc_dir / "metadata.json"
    existing = {}
    if meta_path.exists():
        try:
            existing = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass

    created_at = existing.get("created_at", now)
    if "created_at" not in existing and "created_at" not in locals():
        created_at = now

    doc_meta = {
        "id": doc_id,
        "kb_id": kb_id,
        "name": doc_name,
        "file_type": ext,
        "file_size": file_size,
        "parse_status": "done",  # lowercase — Rust enum uses serde(rename_all="lowercase")
        "parse_error": None,
        "chunk_count": chunk_count,
        "embedding_model": EMBEDDING_MODEL,
        "created_at": existing.get("created_at", now),
        "updated_at": now,
    }
    meta_path.write_text(
        json.dumps(doc_meta, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # Save full.md
    full_md = doc_dir / "full.md"
    if not full_md.exists():
        full_md.write_text(content, encoding="utf-8")

    # Update knowledge_bases.json to reflect document count
    _update_kb_registry(kb_id, chunk_count)


def _remove_doc_from_desktop(kb_id: str, doc_id: str):
    """Remove a document directory and update the KB registry."""
    import shutil
    doc_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id
    if doc_dir.exists():
        shutil.rmtree(doc_dir)

    # Update knowledge_bases.json
    _update_kb_registry(kb_id, -1)


def _update_kb_registry(kb_id: str, chunk_delta: int):
    """Update document_count and chunk_count in knowledge_bases.json."""
    reg_path = Path(DATA_DIR) / "knowledge_bases.json"
    if not reg_path.exists():
        return
    try:
        registry = json.loads(reg_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return

    updated = False
    for kb in registry.get("knowledge_bases", []):
        if kb.get("id") == kb_id:
            # Count actual docs on disk
            docs_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs"
            doc_count = 0
            total_chunks = 0
            if docs_dir.exists():
                for entry in docs_dir.iterdir():
                    if entry.is_dir():
                        meta = entry / "metadata.json"
                        if meta.exists():
                            doc_count += 1
                            try:
                                m = json.loads(meta.read_text(encoding="utf-8"))
                                total_chunks += m.get("chunk_count", 0)
                            except Exception:
                                pass
            kb["document_count"] = doc_count
            kb["chunk_count"] = total_chunks
            if not kb.get("embedding_model"):
                kb["embedding_model"] = EMBEDDING_MODEL
                kb["embedding_dim"] = _embedding_dim_cache.get(EMBEDDING_MODEL, 0)
            kb["updated_at"] = datetime.now(timezone.utc).isoformat()
            updated = True
            break

    if updated:
        reg_path.write_text(
            json.dumps(registry, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


def main():
    """Entry point for `local-kb-mcp` command."""
    import sys

    # Force UTF-8 for stdout/stderr — the MCP protocol uses JSON over stdout,
    # and PyInstaller on Windows defaults to cp936 which corrupts non-ASCII
    # characters (e.g. Chinese/Japanese/Korean text in tool responses).
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    # Disable the FastMCP banner in PyInstaller builds — the Rich-printed
    # banner uses ANSI escape codes and Unicode box-drawing characters that
    # get garbled on Windows when stdout encoding isn't UTF-8.
    is_frozen = getattr(sys, "frozen", False)
    mcp.run(transport="stdio", show_banner=not is_frozen)


if __name__ == "__main__":
    main()
