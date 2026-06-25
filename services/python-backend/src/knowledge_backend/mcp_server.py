"""
MCP Server for Local Knowledge Base — merged into the Python backend.

Provides tools for AI agents (Claude Code, etc.) to search, query,
and manage knowledge bases via stdio transport.

Shares the same LanceDB, embedding, reranker, and chunker modules as the REST API.
Configuration is read from the same settings.json via the backend's config module.
"""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastmcp import FastMCP

from .config import get_config
from .db.lancedb_manager import LanceDBManager
from .embedding import OpenAICompatibleEmbedder
from .reranker import OpenAICompatibleReranker
from .chunker import RecursiveChunker, Chunk
from .mineru_client import (
    MinerUError,
    SUPPORTED_EXTENSIONS,
    is_supported,
    parse_document,
    parse_document_agent,
)

# ── Configuration ──

_config = get_config()
DATA_DIR = _config.knowledge_base_data_dir

mcp = FastMCP(name="Local Knowledge Base")


def _get_db():
    return LanceDBManager(Path(DATA_DIR) / "lancedb_data")


# ── Tools ──

@mcp.tool
def search_knowledge_base(
    query: str,
    kb_id: str,
    top_k: int = 10,
    search_type: Literal["hybrid", "vector", "fts"] = "hybrid",
    rerank: bool = True,
    doc_id_filter: Optional[str] = None,
) -> list[dict]:
    """Search a knowledge base with hybrid (vector + BM25) search and optional reranking."""
    db = _get_db()
    try:
        embedder = OpenAICompatibleEmbedder(
            _config.embedding_api_base,
            _config.embedding_api_key,
            _config.embedding_model,
        )
        query_vector = embedder.embed_single(query)
        embedder.close()

        fetch_k = top_k * 3 if rerank else top_k
        results = db.search(
            kb_id=kb_id,
            query_vector=query_vector,
            query_text=query,
            search_type=search_type,
            top_k=fetch_k,
            doc_id_filter=doc_id_filter,
        )

        if rerank and results and _config.rerank_api_key:
            try:
                reranker = OpenAICompatibleReranker(
                    _config.rerank_api_base,
                    _config.rerank_api_key,
                    _config.rerank_model,
                )
                documents = [r["content"] for r in results]
                reranked = reranker.rerank(query, documents, top_n=top_k)
                reranker.close()
                new_results = []
                for rr in reranked[:top_k]:
                    if rr.index < len(results):
                        results[rr.index]["score"] = rr.score
                        new_results.append(results[rr.index])
                results = new_results
            except Exception:
                results = results[:top_k]
        else:
            results = results[:top_k]

        return results
    finally:
        db.close()


@mcp.tool
def list_knowledge_bases() -> list[dict]:
    """List all knowledge bases with document and chunk counts, detecting orphaned data."""
    registry_path = Path(DATA_DIR) / "knowledge_bases.json"
    kbs = []
    if registry_path.exists():
        try:
            with open(registry_path, encoding="utf-8") as f:
                data = json.load(f)
            kbs = data.get("knowledge_bases", [])
        except (json.JSONDecodeError, OSError):
            pass

    db = _get_db()
    try:
        lancedb_ids = set(db.list_kb_ids())
    finally:
        db.close()

    result = []
    for kb in kbs:
        kb_id = kb["id"]
        orphan_docs = 0
        docs_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs"
        if docs_dir.exists():
            for d in docs_dir.iterdir():
                if d.is_dir():
                    meta = d / "metadata.json"
                    if not meta.exists():
                        orphan_docs += 1

        result.append({
            "id": kb_id,
            "name": kb.get("name", ""),
            "description": kb.get("description", ""),
            "document_count": kb.get("document_count", 0),
            "chunk_count": kb.get("chunk_count", 0),
            "embedding_model": kb.get("embedding_model", ""),
            "embedding_dim": kb.get("embedding_dim", 0),
            "pinned": kb.get("pinned", False),
            "created_at": kb.get("created_at", ""),
            "updated_at": kb.get("updated_at", ""),
            "has_lancedb": kb_id in lancedb_ids,
            "orphan_documents": orphan_docs,
        })

    # Detect KBs in LanceDB but not in registry
    for lid in lancedb_ids:
        if not any(kb["id"] == lid for kb in kbs):
            result.append({
                "id": lid,
                "name": f"[Orphan: {lid}]",
                "description": "Exists in LanceDB but not in registry",
                "document_count": 0, "chunk_count": 0,
                "embedding_model": "", "embedding_dim": 0,
                "pinned": False,
                "created_at": "", "updated_at": "",
                "has_lancedb": True, "orphan_documents": 0,
            })

    return result


@mcp.tool
def get_document(kb_id: str, doc_id: str, include_chunks: bool = False) -> dict:
    """Get full document content with optional chunk details."""
    doc_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id
    if not doc_dir.exists():
        return {"error": f"Document not found: {doc_id}"}

    content = ""
    md_path = doc_dir / "full.md"
    if md_path.exists():
        content = md_path.read_text(encoding="utf-8")

    meta = {}
    meta_path = doc_dir / "metadata.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass

    result = {
        "doc_id": doc_id,
        "kb_id": kb_id,
        "name": meta.get("name", doc_id),
        "content": content,
        "metadata": meta,
    }

    if include_chunks:
        db = _get_db()
        try:
            table = db.get_table(kb_id)
            if table:
                chunks = table.search().where(f"doc_id = '{doc_id}'").to_list()
                chunks.sort(key=lambda c: c.get("chunk_index", 0))
                result["chunks"] = [
                    {
                        "chunk_id": c.get("chunk_id", ""),
                        "content": c.get("content", ""),
                        "chunk_index": c.get("chunk_index", 0),
                        "page_number": c.get("page_number", 0),
                    }
                    for c in chunks
                ]
        finally:
            db.close()

    return result


@mcp.tool
def create_knowledge_base(name: str, description: str = "") -> dict:
    """Create a new knowledge base."""
    kb_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    kb_data = {
        "id": kb_id, "name": name, "description": description,
        "created_at": now, "updated_at": now,
        "document_count": 0, "chunk_count": 0,
        "embedding_model": "", "embedding_dim": 0, "pinned": False,
    }

    registry_path = Path(DATA_DIR) / "knowledge_bases.json"
    registry = {"version": 1, "knowledge_bases": []}
    if registry_path.exists():
        try:
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    registry["knowledge_bases"].append(kb_data)
    registry_path.write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")

    kb_dir = Path(DATA_DIR) / f"kb_{kb_id}"
    kb_dir.mkdir(parents=True, exist_ok=True)
    (kb_dir / "docs").mkdir(exist_ok=True)

    # Create LanceDB table
    embedding_dim = 0
    try:
        embedder = OpenAICompatibleEmbedder(
            _config.embedding_api_base, _config.embedding_api_key, _config.embedding_model,
        )
        embedding_dim = embedder.dimension or 0
        embedder.close()
    except Exception:
        pass

    db = _get_db()
    try:
        db.create_table(kb_id, embedding_dim or 1536)
    finally:
        db.close()

    kb_data["embedding_dim"] = embedding_dim
    return kb_data


@mcp.tool
def delete_knowledge_base(kb_id: str) -> dict:
    """Delete a knowledge base and all its data."""
    registry_path = Path(DATA_DIR) / "knowledge_bases.json"
    if registry_path.exists():
        try:
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
            registry["knowledge_bases"] = [
                kb for kb in registry["knowledge_bases"] if kb["id"] != kb_id
            ]
            registry_path.write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")
        except (json.JSONDecodeError, OSError):
            pass

    import shutil
    kb_dir = Path(DATA_DIR) / f"kb_{kb_id}"
    if kb_dir.exists():
        shutil.rmtree(kb_dir)

    db = _get_db()
    try:
        db.drop_table(kb_id)
    finally:
        db.close()

    return {"status": "deleted", "kb_id": kb_id}


@mcp.tool
def rename_knowledge_base(kb_id: str, name: str, description: Optional[str] = None) -> dict:
    """Rename a knowledge base and optionally update its description."""
    registry_path = Path(DATA_DIR) / "knowledge_bases.json"
    if not registry_path.exists():
        return {"error": "Registry not found"}

    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    for kb in registry["knowledge_bases"]:
        if kb["id"] == kb_id:
            kb["name"] = name
            if description is not None:
                kb["description"] = description
            kb["updated_at"] = datetime.now(timezone.utc).isoformat()
            registry_path.write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")
            return kb

    return {"error": f"Knowledge base not found: {kb_id}"}


@mcp.tool
def add_document(
    kb_id: str,
    content: Optional[str] = None,
    file_path: Optional[str] = None,
    chunk_size: int = 512,
    chunk_overlap: int = 50,
) -> dict:
    """Add a document to a knowledge base. Provide either content (text) or file_path (to be parsed)."""
    if not content and not file_path:
        return {"error": "Either content or file_path must be provided"}
    if content and file_path:
        return {"error": "Provide only one of content or file_path, not both"}

    doc_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    if content:
        doc_name = f"doc-{doc_id[:8]}.md"
        markdown_content = content
        file_type = "md"
    else:
        fp = Path(file_path)
        if not fp.exists():
            return {"error": f"File not found: {file_path}"}
        doc_name = fp.name
        file_type = fp.suffix.lstrip(".").lower()
        if not is_supported(fp):
            return {"error": f"Unsupported file type: {file_type}"}

        # Parse with MinerU
        file_size = fp.stat().st_size
        try:
            if file_size <= 10 * 1024 * 1024 and not _config.mineru_token:
                markdown_content = parse_document_agent(str(fp))
            elif _config.mineru_token:
                markdown_content = parse_document(str(fp), _config.mineru_token)
            else:
                return {"error": "File too large for agent mode and no MinerU token configured"}
        except MinerUError as e:
            return {"error": f"MinerU parse failed: {e}"}

    # Write document to KB directory
    doc_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)

    meta = {
        "id": doc_id, "kb_id": kb_id, "name": doc_name,
        "file_type": file_type, "file_size": len(markdown_content.encode("utf-8")),
        "parse_status": "done", "parse_error": None,
        "chunk_count": 0, "embedding_model": "",
        "created_at": now, "updated_at": now,
    }
    (doc_dir / "metadata.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    (doc_dir / "full.md").write_text(markdown_content, encoding="utf-8")

    # Index: chunk + embed
    chunker = RecursiveChunker(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    chunks = chunker.chunk(markdown_content, metadata={"doc_id": doc_id, "doc_name": doc_name})

    embedder = OpenAICompatibleEmbedder(
        _config.embedding_api_base, _config.embedding_api_key, _config.embedding_model,
    )
    chunk_texts = [c.content for c in chunks]
    vectors = embedder.embed_batch(chunk_texts)
    embedder.close()

    db = _get_db()
    try:
        table = db.get_table(kb_id)
        if table is None:
            embedding_dim = len(vectors[0]) if vectors else 1536
            db.create_table(kb_id, embedding_dim)
            table = db.get_table(kb_id)

        # Delete old chunks for this doc
        try:
            table.delete(f"doc_id = '{doc_id}'")
        except Exception:
            pass

        rows = []
        for i, (chunk, vec) in enumerate(zip(chunks, vectors)):
            rows.append({
                "chunk_id": f"{doc_id}-chunk-{i}",
                "doc_id": doc_id,
                "kb_id": kb_id,
                "doc_name": doc_name,
                "content": chunk.content,
                "chunk_index": i,
                "page_number": chunk.metadata.get("page", 0) if isinstance(chunk.metadata, dict) else 0,
                "chunk_strategy": "recursive",
                "metadata_json": json.dumps(chunk.metadata, ensure_ascii=False) if isinstance(chunk.metadata, dict) else "{}",
                "vector": vec,
            })
        table.add(rows)
    finally:
        db.close()

    # Update registry counts
    _update_kb_counts(kb_id)

    meta["chunk_count"] = len(chunks)
    meta["embedding_model"] = _config.embedding_model
    (doc_dir / "metadata.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    return {"doc_id": doc_id, "name": doc_name, "chunk_count": len(chunks), "status": "indexed"}


def _update_kb_counts(kb_id: str):
    """Update document_count and chunk_count in registry and in-memory."""
    doc_count = 0
    chunk_count = 0
    docs_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs"
    if docs_dir.exists():
        for d in docs_dir.iterdir():
            if d.is_dir() and (d / "metadata.json").exists():
                doc_count += 1
                try:
                    meta = json.loads((d / "metadata.json").read_text(encoding="utf-8"))
                    chunk_count += meta.get("chunk_count", 0)
                except Exception:
                    pass

    registry_path = Path(DATA_DIR) / "knowledge_bases.json"
    if registry_path.exists():
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        for kb in registry.get("knowledge_bases", []):
            if kb["id"] == kb_id:
                kb["document_count"] = doc_count
                kb["chunk_count"] = chunk_count
                kb["updated_at"] = datetime.now(timezone.utc).isoformat()
                registry_path.write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")
                break


@mcp.tool
def delete_document(kb_id: str, doc_id: str) -> dict:
    """Delete a document and all its chunks from a knowledge base."""
    import shutil
    doc_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id
    if doc_dir.exists():
        shutil.rmtree(doc_dir)

    db = _get_db()
    try:
        table = db.get_table(kb_id)
        if table:
            try:
                table.delete(f"doc_id = '{doc_id}'")
            except Exception:
                pass
    finally:
        db.close()

    _update_kb_counts(kb_id)
    return {"status": "deleted", "doc_id": doc_id}


@mcp.tool
def rename_document(kb_id: str, doc_id: str, new_name: str) -> dict:
    """Rename a document in a knowledge base."""
    meta_path = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id / "metadata.json"
    if not meta_path.exists():
        return {"error": f"Document not found: {doc_id}"}

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["name"] = new_name
    meta["updated_at"] = datetime.now(timezone.utc).isoformat()
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    # Also update doc_name in LanceDB chunks
    db = _get_db()
    try:
        table = db.get_table(kb_id)
        if table:
            # LanceDB doesn't support UPDATE directly; re-insert with new name
            chunks = table.search().where(f"doc_id = '{doc_id}'").to_list()
            if chunks:
                table.delete(f"doc_id = '{doc_id}'")
                for c in chunks:
                    c["doc_name"] = new_name
                table.add(chunks)
    finally:
        db.close()

    return {"status": "renamed", "doc_id": doc_id, "name": new_name}


@mcp.tool
def move_document(kb_id: str, doc_id: str, path: Optional[str] = None) -> dict:
    """Move a document to a folder path. Set path to null/None to move to root."""
    meta_path = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id / "metadata.json"
    if not meta_path.exists():
        return {"error": f"Document not found: {doc_id}"}

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["path"] = path
    meta["updated_at"] = datetime.now(timezone.utc).isoformat()
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"status": "moved", "doc_id": doc_id, "path": path}


@mcp.tool
def list_folders(kb_id: str) -> list[str]:
    """List all folder paths in a knowledge base."""
    docs_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs"
    if not docs_dir.exists():
        return []

    paths = set()
    for d in docs_dir.iterdir():
        if d.is_dir():
            meta_file = d / "metadata.json"
            if meta_file.exists():
                try:
                    meta = json.loads(meta_file.read_text(encoding="utf-8"))
                    p = meta.get("path") or meta.get("folder")
                    if p:
                        paths.add(p)
                        # Also add parent paths for tree building
                        parts = p.split("/")
                        for i in range(1, len(parts)):
                            paths.add("/".join(parts[:i]))
                except Exception:
                    pass
    return sorted(paths)


@mcp.tool
def get_document_chunks(kb_id: str, doc_id: str) -> dict:
    """Get all chunks of a document, sorted by chunk_index. Returns full chunk contents."""
    doc_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id
    if not doc_dir.exists():
        return {"error": f"Document not found: {doc_id}"}

    # Get document metadata
    meta = {}
    meta_path = doc_dir / "metadata.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    db = _get_db()
    try:
        table = db.get_table(kb_id)
        if table is None:
            return {"error": f"Knowledge base not found: {kb_id}"}

        chunks = table.search().where(f"doc_id = '{doc_id}'").to_list()
        chunks.sort(key=lambda c: c.get("chunk_index", 0))

        return {
            "doc_id": doc_id,
            "kb_id": kb_id,
            "name": meta.get("name", doc_id),
            "chunk_count": len(chunks),
            "chunks": [
                {
                    "chunk_id": c.get("chunk_id", ""),
                    "content": c.get("content", ""),
                    "chunk_index": c.get("chunk_index", 0),
                    "page_number": c.get("page_number", 0),
                    "metadata": json.loads(c.get("metadata_json", "{}")) if c.get("metadata_json") else {},
                }
                for c in chunks
            ],
        }
    finally:
        db.close()


# ── Entry Point ──

def main():
    """Entry point for the MCP stdio server."""
    mcp.run(transport="stdio")
