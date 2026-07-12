"""
MCP Server for SKB (Super Knowledge Base) — merged into the Python backend.

Provides tools for AI agents (Claude Code, etc.) to search, query,
and manage knowledge bases via stdio transport.

Shares the same LanceDB, embedding, reranker, and chunker modules as the REST API.
Configuration is read from the same settings.json via the backend's config module.
"""

import json
import os
import re
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

mcp = FastMCP(name="SKB")


def _compute_page_offset(doc_dir: Path, doc_name: str) -> int:
    """Re-exported from api/documents.py — single source of truth."""
    from knowledge_backend.api.documents import _compute_page_offset as _f
    return _f(doc_dir, doc_name)


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
    context_window: int = 0,
) -> list[dict]:
    """PRIMARY tool for Q&A. Hybrid search (vector + BM25 + optional rerank) on a single KB.

    Use this FIRST for any question — it returns the most relevant chunks.
    Set context_window > 0 to also get neighboring chunks for each hit.
    Use doc_id_filter to restrict to a specific document after discovering its relevance.

    Results include content_type (text/image/table/equation). When you see
    content_type='image' chunks, you MUST call read_document_image to fetch the
    actual image and display it inline — NEVER invent or guess image URLs.
    Images are key visual evidence; always include them in your answer when
    relevant.

    After searching, use get_chunk_by_index if you need more adjacent context,
    or get_document_summary to understand the source document's structure.
    Do NOT use get_document for Q&A — documents can be hundreds of pages."""
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
                        r = results[rr.index]
                        if len(r.get("content", "").strip()) >= 20:
                            r["score"] = rr.score
                            new_results.append(r)
                results = new_results
            except Exception:
                results = [r for r in results[:top_k] if len(r.get("content", "").strip()) >= 20]
        else:
            results = [r for r in results[:top_k] if len(r.get("content", "").strip()) >= 20]

        # Enrich with neighboring chunks if requested
        if context_window > 0 and results:
            results = db.enrich_with_context(results, kb_id, context_window)

        return results
    finally:
        db.close()


@mcp.tool
def search_all_knowledge_bases(
    query: str,
    kb_ids: Optional[list[str]] = None,
    top_k: int = 10,
    search_type: Literal["hybrid", "vector", "fts"] = "hybrid",
    rerank: bool = True,
    context_window: int = 0,
) -> list[dict]:
    """Search across ALL knowledge bases (or specified ones). Returns top results.

    Use this when you don't know which KB contains relevant information.
    After finding results, use the returned kb_id with search_knowledge_base
    for deeper search within that KB, or get_document_summary to explore a document.

    Results include content_type (text/image/table/equation). When you see
    content_type='image' chunks, call read_document_image to display the actual
    image — NEVER make up image URLs. Always include relevant images in your answer."""
    db = _get_db()
    try:
        embedder = OpenAICompatibleEmbedder(
            _config.embedding_api_base,
            _config.embedding_api_key,
            _config.embedding_model,
        )
        query_vector = embedder.embed_single(query)
        embedder.close()

        # Determine which KBs to search
        available_kb_ids = db.list_kb_ids()
        if kb_ids:
            target_kb_ids = [k for k in kb_ids if k in available_kb_ids]
        else:
            target_kb_ids = available_kb_ids

        if not target_kb_ids:
            return []

        fetch_k = top_k * 3 if rerank else top_k
        per_kb = max(fetch_k // max(len(target_kb_ids), 1), 3)

        all_results = []
        for kb_id in target_kb_ids:
            try:
                kb_results = db.search(
                    kb_id=kb_id,
                    query_vector=query_vector,
                    query_text=query,
                    search_type=search_type,
                    top_k=per_kb,
                )
                all_results.extend(kb_results)
            except Exception:
                continue

        # Sort by score
        all_results.sort(key=lambda x: x.get("score", 0), reverse=True)

        # Optional rerank
        if rerank and all_results and _config.rerank_api_key:
            try:
                reranker = OpenAICompatibleReranker(
                    _config.rerank_api_base,
                    _config.rerank_api_key,
                    _config.rerank_model,
                )
                documents = [r["content"] for r in all_results]
                reranked = reranker.rerank(query, documents, top_n=top_k)
                reranker.close()
                new_results = []
                for rr in reranked[:top_k]:
                    if rr.index < len(all_results):
                        r = all_results[rr.index]
                        if len(r.get("content", "").strip()) >= 20:
                            r["score"] = rr.score
                            new_results.append(r)
                all_results = new_results
            except Exception:
                all_results = [r for r in all_results[:top_k] if len(r.get("content", "").strip()) >= 20]
        else:
            all_results = [r for r in all_results[:top_k] if len(r.get("content", "").strip()) >= 20]

        # Enrich with context if requested — group by kb_id for per-KB lookup
        if context_window > 0 and all_results:
            by_kb: dict[str, list[dict]] = {}
            for r in all_results:
                by_kb.setdefault(r.get("kb_id", ""), []).append(r)
            enriched = []
            for kb, group in by_kb.items():
                if kb:
                    enriched.extend(db.enrich_with_context(group, kb, context_window))
                else:
                    enriched.extend(group)
            all_results = enriched

        return all_results
    finally:
        db.close()


@mcp.tool
def search_document(
    query: str,
    kb_id: str,
    doc_id: str,
    top_k: int = 10,
    search_type: Literal["hybrid", "vector", "fts"] = "hybrid",
    rerank: bool = True,
    context_window: int = 0,
) -> list[dict]:
    """Search within a SINGLE document. Use when you already know which document
    contains the answer and want precise results without KB-wide noise.

    This is a focused version of search_knowledge_base scoped to one doc_id.
    Results include content_type — display image chunks with read_document_image."""
    return search_knowledge_base(
        query=query,
        kb_id=kb_id,
        top_k=top_k,
        search_type=search_type,
        rerank=rerank,
        doc_id_filter=doc_id,
        context_window=context_window,
    )


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
def list_documents(kb_id: str) -> list[dict]:
    """List all documents in a knowledge base with metadata (name, type, size, chunks, etc.)."""
    docs_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs"
    if not docs_dir.exists():
        return []

    results = []
    for d in sorted(docs_dir.iterdir()):
        if not d.is_dir():
            continue
        meta_path = d / "metadata.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            results.append({
                "doc_id": meta.get("id", d.name),
                "name": meta.get("name", d.name),
                "file_type": meta.get("file_type", ""),
                "file_size": meta.get("file_size", 0),
                "chunk_count": meta.get("chunk_count", 0),
                "parse_status": meta.get("parse_status", "unknown"),
                "path": meta.get("path"),
                "created_at": meta.get("created_at", ""),
                "updated_at": meta.get("updated_at", ""),
            })
        except (json.JSONDecodeError, OSError):
            pass
    return results


@mcp.tool
def get_document(kb_id: str, doc_id: str, include_chunks: bool = False, max_chars: int = 30000) -> dict:
    """Get raw document content. Truncated if exceeds max_chars (0=no limit).

    ⚠️ NOT for Q&A — use search_knowledge_base to find relevant chunks instead.
    Only use this for document management tasks (editing, reviewing full structure)."""
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

    total_chars = len(content)
    truncated = False
    if max_chars > 0 and len(content) > max_chars:
        content = content[:max_chars]
        truncated = True

    result = {
        "doc_id": doc_id,
        "kb_id": kb_id,
        "name": meta.get("name", doc_id),
        "content": content,
        "total_chars": total_chars,
        "truncated": truncated,
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
                        "page_start": c.get("page_start"),
                        "page_end": c.get("page_end"),
                    }
                    for c in chunks
                ]
        finally:
            db.close()

    return result


@mcp.tool
def get_document_summary(kb_id: str, doc_id: str) -> dict:
    """Get document structure WITHOUT loading content: metadata, heading outline, first/last chunk previews.

    Use this after search_knowledge_base to understand what a document covers,
    or to decide which chunks to fetch next. Not a substitute for search — use
    search_knowledge_base first, then use this to explore a specific document's structure."""
    import re

    doc_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id
    if not doc_dir.exists():
        return {"error": f"Document not found: {doc_id}"}

    # Metadata
    meta = {}
    meta_path = doc_dir / "metadata.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass

    # Extract headings from markdown (table of contents)
    headings = []
    md_path = doc_dir / "full.md"
    if md_path.exists():
        heading_pattern = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
        for m in heading_pattern.finditer(md_path.read_text(encoding="utf-8")):
            headings.append({"level": len(m.group(1)), "text": m.group(2).strip()})

    # Get first 3 and last 2 chunks as preview
    db = _get_db()
    try:
        table = db.get_table(kb_id)
        if table is not None:
            all_chunks = table.search().where(f"doc_id = '{doc_id}'").to_list()
            all_chunks.sort(key=lambda c: c.get("chunk_index", 0))
            total_chunks = len(all_chunks)

            def _format(c):
                return {
                    "chunk_index": c.get("chunk_index", 0),
                    "content": c.get("content", ""),
                    "page_number": c.get("page_number", 0),
                    "page_start": c.get("page_start"),
                    "page_end": c.get("page_end"),
                }

            preview_begin = [_format(c) for c in all_chunks[:3]]
            preview_end = [_format(c) for c in all_chunks[-2:]] if total_chunks > 3 else []
        else:
            total_chunks = 0
            preview_begin = []
            preview_end = []
    finally:
        db.close()

    return {
        "doc_id": doc_id,
        "kb_id": kb_id,
        "name": meta.get("name", doc_id),
        "file_type": meta.get("file_type", ""),
        "file_size": meta.get("file_size", 0),
        "chunk_count": meta.get("chunk_count", total_chunks),
        "headings": headings,
        "total_headings": len(headings),
        "preview_begin_chunks": preview_begin,
        "preview_end_chunks": preview_end,
        "created_at": meta.get("created_at", ""),
    }


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

    # Resolve embedding model and dimension
    embedding_model = _config.embedding_model
    embedding_dim = 0
    if embedding_model:
        try:
            embedder = OpenAICompatibleEmbedder(
                _config.embedding_api_base, _config.embedding_api_key, embedding_model,
            )
            embedding_dim = embedder.get_dimension() or 0
            embedder.close()
        except Exception:
            pass

    kb_data["embedding_model"] = embedding_model
    kb_data["embedding_dim"] = embedding_dim

    db = _get_db()
    try:
        db.create_table(kb_id, embedding_dim or 1536)
    finally:
        db.close()

    # Persist resolved model/dim back to registry
    _update_kb_embedding(kb_id, embedding_model, embedding_dim)

    return kb_data


def _update_kb_embedding(kb_id: str, model: str, dim: int):
    """Update embedding_model and embedding_dim for a KB in the registry."""
    registry_path = Path(DATA_DIR) / "knowledge_bases.json"
    if not registry_path.exists():
        return
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        for kb in registry.get("knowledge_bases", []):
            if kb["id"] == kb_id:
                kb["embedding_model"] = model
                kb["embedding_dim"] = dim
                kb["updated_at"] = datetime.now(timezone.utc).isoformat()
                registry_path.write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")
                break
    except (json.JSONDecodeError, OSError):
        pass


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
        if not is_supported(fp) and file_type != "zip":
            return {"error": f"Unsupported file type: {file_type}"}

        # If it's a MinerU ZIP bundle (dev mode replay), extract directly
        if file_type == "zip":
            from .mineru_client import _download_and_extract
            import httpx
            try:
                with httpx.Client(timeout=60.0) as _http:
                    parse_result = _download_and_extract(_http, f"file:///{fp.as_posix()}")
                    # _download_and_extract tries HTTP, which won't work for local files.
                    # Fallback: extract the ZIP ourselves
                    parse_result = _extract_local_zip(fp)
                doc_name = fp.stem + ".pdf"  # original was PDF
                file_type = "pdf"
            except Exception as e:
                return {"error": f"ZIP extraction failed: {e}"}
        else:
            # Parse with MinerU
            file_size = fp.stat().st_size
            parse_result = None
            try:
                if file_size <= 10 * 1024 * 1024 and not _config.mineru_token:
                    parse_result = parse_document_agent(str(fp))
                elif _config.mineru_token:
                    parse_result = parse_document(str(fp), _config.mineru_token)
                else:
                    return {"error": "File too large for agent mode and no MinerU token configured"}
            except MinerUError as e:
                return {"error": f"MinerU parse failed: {e}"}

        markdown_content = parse_result.markdown

    # Write document markdown to KB directory (metadata saved only after indexing)
    doc_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)
    (doc_dir / "full.md").write_text(markdown_content, encoding="utf-8")

    # Save MinerU ZIP for dev mode caching/replay
    if _config.dev_mode and parse_result and parse_result.raw_zip:
        try:
            (doc_dir / "mineru_bundle.zip").write_bytes(parse_result.raw_zip)
        except Exception:
            pass

    # Save MinerU JSON for page number tracking
    if parse_result and parse_result.json_content:
        (doc_dir / "mineru_result.json").write_text(parse_result.json_content, encoding="utf-8")
    # Save content_list.json for direct page_idx-based mapping
    if parse_result and parse_result.content_list_json:
        (doc_dir / "content_list.json").write_text(parse_result.content_list_json, encoding="utf-8")
    # Save extracted images
    image_descriptions: dict[str, tuple[str, dict]] = {}
    if parse_result and parse_result.extracted_images and _config.extract_multimodal:
        img_dir = doc_dir / "images"
        img_dir.mkdir(exist_ok=True)
        for fname, data in parse_result.extracted_images.items():
            (img_dir / fname).write_bytes(data)
        # Generate VLM descriptions if configured (skip cached, process concurrently)
        has_vlm = _config.vlm_enabled and bool(_config.vlm_api_base.strip() and _config.vlm_model.strip())
        if has_vlm:
            from .vision import describe_image
            from .api.documents import _load_image_meta, _is_valid_description, _save_image_meta_batch
            import httpx
            from concurrent.futures import ThreadPoolExecutor, as_completed
            cached_meta = _load_image_meta(doc_dir)
            new_meta_entries: dict[str, tuple[str, dict]] = {}
            pending: list[tuple[str, bytes]] = []

            for fname, data in parse_result.extracted_images.items():
                if _is_valid_description(cached_meta.get(fname, {}).get("description", "")):
                    image_descriptions[fname] = (
                        cached_meta[fname]["description"],
                        cached_meta[fname].get("entity_info", {}),
                    )
                else:
                    pending.append((fname, data))

            if pending:
                MAX_VLM_RETRIES = 3

                def _describe_one(fname: str, data: bytes) -> tuple[str, str, dict]:
                    fmt = Path(fname).suffix.lstrip(".") or "png"
                    last_error = ""
                    for attempt in range(MAX_VLM_RETRIES):
                        try:
                            with httpx.Client(timeout=60.0) as client:
                                desc, entity = describe_image(
                                    data, fmt,
                                    vlm_api_base=_config.vlm_api_base,
                                    vlm_api_key=_config.vlm_api_key,
                                    vlm_model=_config.vlm_model,
                                    http=client,
                                )
                            if _is_valid_description(desc):
                                return fname, desc, entity, ""
                            last_error = f"empty/invalid description (attempt {attempt+1})"
                        except Exception as e:
                            last_error = str(e)
                        if attempt < MAX_VLM_RETRIES - 1:
                            import time as _t; _t.sleep(1.0 * (attempt + 1))
                    return fname, "[Image - no description available]", {"entity_name": fname, "entity_type": "image", "summary": ""}, last_error

                workers = min(max(1, _config.vlm_concurrency), len(pending))
                with ThreadPoolExecutor(max_workers=workers) as executor:
                    futures = {executor.submit(_describe_one, fname, data): fname for fname, data in pending}
                    for future in as_completed(futures):
                        fname, desc, entity, err = future.result()
                        if err:
                            print(f"[mcp] VLM failed for {fname}: {err}", file=sys.stderr)
                        image_descriptions[fname] = (desc, entity)
                        new_meta_entries[fname] = (desc, entity)

            if new_meta_entries:
                _save_image_meta_batch(doc_dir, new_meta_entries)

            # Second pass: retry any images that still have no valid description
            missed = []
            for fname, (desc, _) in image_descriptions.items():
                if not _is_valid_description(desc):
                    missed.append(fname)
            if missed:
                from concurrent.futures import ThreadPoolExecutor as RetryExecutor, as_completed as retry_ac
                print(f"[mcp] Retrying {len(missed)} images that have no valid description...", file=sys.stderr)
                retry_items = [(fname, parse_result.extracted_images[fname])
                               for fname in missed if fname in parse_result.extracted_images]
                if retry_items:
                    retry_workers = min(max(1, _config.vlm_concurrency), len(retry_items))
                    retry_meta: dict[str, tuple[str, dict]] = {}
                    with RetryExecutor(max_workers=retry_workers) as retry_ex:
                        retry_futures = {retry_ex.submit(_describe_one, fname, data): fname
                                         for fname, data in retry_items}
                        for future in retry_ac(retry_futures):
                            fname = retry_futures[future]
                            _, desc, entity, err = future.result()
                            if err:
                                print(f"[mcp] Retry VLM failed for {fname}: {err}", file=sys.stderr)
                            if _is_valid_description(desc):
                                image_descriptions[fname] = (desc, entity)
                                retry_meta[fname] = (desc, entity)
                    if retry_meta:
                        _save_image_meta_batch(doc_dir, retry_meta)
                still = sum(1 for d in image_descriptions.values() if not _is_valid_description(d[0]))
                print(f"[mcp] After retry: {still} images still without valid description", file=sys.stderr)

    # Compute page offset for split documents BEFORE injecting markers
    page_offset = _compute_page_offset(doc_dir, doc_name)

    # Inject [PAGE:N] markers into markdown so chunks carry page info
    from .api.documents import _inject_page_markers as _inject_pm, _extract_page_range as _extract_pr
    tagged_md = _inject_pm(markdown_content, doc_dir)
    if page_offset > 0:
        import re as _re2
        tagged_md = _re2.sub(
            r"\[PAGE:(\d+)(?:\|(-?\d+))?\]",
            lambda m: f"[PAGE:{int(m.group(1)) + page_offset}]",
            tagged_md,
        )

    chunker = RecursiveChunker(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    chunks = chunker.chunk(tagged_md, metadata={"doc_id": doc_id, "doc_name": doc_name},
                           page_mapper=None)

    # Split chunks that span multiple pages at PAGE marker boundaries.
    import copy as _copy_mod
    _split_chunks = []
    for c in chunks:
        markers = list(re.finditer(r"\[PAGE:(\d+)(?:\|(-?\d+))?\]", c.content))
        pages_seen = {int(m.group(1)) for m in markers}
        if len(pages_seen) <= 1:
            _split_chunks.append(c)
        else:
            leading = c.content[:markers[0].start()].strip()
            for i, m in enumerate(markers):
                start = m.end()
                end = markers[i + 1].start() if i + 1 < len(markers) else len(c.content)
                sub = c.content[start:end].strip()
                if i == 0 and leading:
                    sub = leading + "\n" + sub if sub else leading
                if sub:
                    nc = _copy_mod.deepcopy(c)
                    nc.content = sub
                    page = int(m.group(1))
                    nc.metadata["page"] = page
                    nc.metadata["page_start"] = page
                    nc.metadata["page_end"] = page
                    if m.group(2) is not None:
                        nc.metadata["start_char"] = int(m.group(2))
                    _split_chunks.append(nc)
    chunks = _split_chunks if _split_chunks else chunks

    # Merge adjacent small chunks produced by PAGE-marker splitting
    try:
        from .chunker import RecursiveChunker
        chunks = RecursiveChunker._merge_small_chunks(chunks)
    except ImportError:
        pass

    # Extract page ranges from markers (for non-split chunks)
    last_page = 0
    for c in chunks:
        if "page_start" not in c.metadata:
            ps, pe, sc, clean = _extract_pr(c.content)
            c.content = clean
            if ps == 0 and pe == 0:
                ps = pe = last_page if last_page > 0 else 1
            c.metadata["page"] = ps
            c.metadata["page_start"] = ps
            c.metadata["page_end"] = pe
            if sc is not None:
                c.metadata["start_char"] = sc
        else:
            c.content = re.sub(r"\[PAGE:\d+(?:\|-?\d+)?\]", "", c.content)
            ps = c.metadata["page_start"]
        if ps > 0:
            last_page = ps

    # Map chunk start_char (fallback for chunks without embedded position).
    # Most chunks already have start_char from PAGE markers.
    _search_from = 0
    for c in chunks:
        if "start_char" in c.metadata and isinstance(c.metadata.get("start_char"), int) and c.metadata["start_char"] >= 0:
            _search_from = max(_search_from, c.metadata["start_char"] + len(c.content))
        else:
            if c.content.strip():
                lookback = max(0, _search_from - 256)
                idx = markdown_content.find(c.content, lookback)
                if idx < 0:
                    prefix = c.content[:80]
                    idx = markdown_content.find(prefix, lookback)
                if idx < 0 and _search_from > 0:
                    idx = markdown_content.find(c.content, 0)
                    if idx < 0:
                        idx = markdown_content.find(c.content[:80], 0)
                if idx >= 0:
                    c.metadata["start_char"] = idx
                    _search_from = idx + len(c.content)

    # Generate multimodal chunks from content_list.json
    mm_chunks = []
    if parse_result and parse_result.content_list_json and _config.extract_multimodal:
        try:
            from .page_mapper import extract_multimodal_items
            from .chunker import multimodal_chunks_from_content_list
            cl_data = json.loads(parse_result.content_list_json)
            mm_items = extract_multimodal_items(cl_data)
            mm_chunks = multimodal_chunks_from_content_list(
                mm_items,
                metadata={"doc_id": doc_id, "doc_name": doc_name},
                image_descriptions=image_descriptions if image_descriptions else None,
            )
        except Exception as e:
            print(f"[mcp] multimodal chunk generation failed: {e}", file=sys.stderr)

    all_chunks = chunks + mm_chunks

    # Multimodal chunks use raw page_idx (0-based); convert to 1-based
    # and apply page_offset for split documents
    mm_offset = (page_offset if page_offset > 0 else 0) + 1
    for c in mm_chunks:
        for key in ("page", "page_start", "page_end"):
            val = c.metadata.get(key, 0)
            if isinstance(val, int):
                c.metadata[key] = val + mm_offset
        if page_offset > 0:
            c.content = re.sub(
                r"Page:\s*(\d+)",
                lambda m: f"Page: {int(m.group(1)) + page_offset}",
                c.content,
            )

    embedder = OpenAICompatibleEmbedder(
        _config.embedding_api_base, _config.embedding_api_key, _config.embedding_model,
    )
    try:
        chunk_texts = [c.content for c in all_chunks]
        vectors = embedder.embed(chunk_texts)
    finally:
        embedder.close()

    db = _get_db()
    try:
        table = db.get_table(kb_id)
        if table is None:
            embedding_dim = len(vectors[0]) if vectors else 1536
            db.create_table(kb_id, embedding_dim)
            table = db.get_table(kb_id)

        # Delete old chunks for this doc (re-index scenario)
        try:
            table.delete(f"doc_id = '{doc_id}'")
        except Exception:
            pass

        rows = []
        for i, (chunk, vec) in enumerate(zip(all_chunks, vectors)):
            meta = chunk.metadata if isinstance(chunk.metadata, dict) else {}
            rows.append({
                "chunk_id": f"{doc_id}-chunk-{i}",
                "doc_id": doc_id,
                "kb_id": kb_id,
                "doc_name": doc_name,
                "content": chunk.content,
                "chunk_index": i,
                "page_number": meta.get("page", 0),
                "chunk_strategy": "recursive",
                "metadata_json": json.dumps(meta, ensure_ascii=False),
                "vector": vec,
            })
        table.add(rows)
    finally:
        db.close()

    chunk_count = len(all_chunks)

    # Only write metadata AFTER successful indexing — prevents orphaned docs
    meta = {
        "id": doc_id, "kb_id": kb_id, "name": doc_name,
        "file_type": file_type, "file_size": len(markdown_content.encode("utf-8")),
        "parse_status": "done", "parse_error": None,
        "chunk_count": chunk_count, "embedding_model": _config.embedding_model,
        "created_at": now, "updated_at": now,
    }
    (doc_dir / "metadata.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    # Update registry counts
    _update_kb_counts(kb_id)

    return {"doc_id": doc_id, "name": doc_name, "chunk_count": len(chunks), "status": "indexed"}


def _extract_local_zip(zip_path: Path) -> "ParseResult":
    """Extract a local MinerU ZIP bundle (dev mode replay)."""
    import zipfile
    from io import BytesIO
    from .mineru_client import ParseResult

    data = zip_path.read_bytes()
    markdown = None
    json_content = None
    content_list_json = None
    extracted_images: dict[str, bytes] = {}
    _IMG_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg"}

    with zipfile.ZipFile(BytesIO(data)) as zf:
        for name in zf.namelist():
            nl = name.lower()
            if nl.endswith("full.md") or nl == "full.md":
                markdown = zf.read(name).decode("utf-8")
            elif nl.endswith(".json"):
                try:
                    raw = zf.read(name).decode("utf-8")
                except Exception:
                    continue
                if '"pdf_info"' in raw:
                    json_content = raw
                elif '"page_idx"' in raw and '"type"' in raw:
                    content_list_json = raw
            elif Path(name).suffix.lower() in _IMG_EXTS:
                try:
                    extracted_images[Path(name).name] = zf.read(name)
                except Exception:
                    pass

    if markdown is None:
        raise ValueError("full.md not found in ZIP")

    return ParseResult(
        markdown=markdown,
        json_content=json_content,
        content_list_json=content_list_json,
        extracted_images=extracted_images or None,
        raw_zip=data,
    )


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
                # Backfill embedding model if missing (e.g. KB created before fix)
                if not kb.get("embedding_model") and _config.embedding_model:
                    kb["embedding_model"] = _config.embedding_model
                    kb.setdefault("embedding_dim", 0)
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
def get_document_chunks(kb_id: str, doc_id: str, limit: int = 0) -> dict:
    """Get chunks of a document, sorted by chunk_index. Returns full chunk contents.

    limit: 0 = all chunks, N > 0 = first N chunks, N < 0 = last |N| chunks.
    Use a positive limit to preview the document without overwhelming context.
    Use a negative limit to see the ending chunks.

    Not for Q&A — use search_knowledge_base to find relevant content first.
    Use this to explore a document's structure after search results point to it."""
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

        total = len(chunks)
        if limit > 0:
            chunks = chunks[:limit]
        elif limit < 0:
            chunks = chunks[limit:]

        def _format_chunk(c):
            raw_meta = {}
            try:
                raw_meta = json.loads(c.get("metadata_json", "{}")) if c.get("metadata_json") else {}
            except (json.JSONDecodeError, TypeError):
                pass
            return {
                "chunk_id": c.get("chunk_id", ""),
                "content": c.get("content", ""),
                "chunk_index": c.get("chunk_index", 0),
                "page_number": c.get("page_number", 0),
                "page_start": c.get("page_start"),
                "page_end": c.get("page_end"),
                "content_type": raw_meta.get("content_type", "text"),
                "metadata": raw_meta,
            }

        result = {
            "doc_id": doc_id,
            "kb_id": kb_id,
            "name": meta.get("name", doc_id),
            "total_chunks": total,
            "returned_chunks": len(chunks),
            "chunks": [_format_chunk(c) for c in chunks],
        }
        if limit != 0:
            result["limit"] = limit
        return result
    finally:
        db.close()


@mcp.tool
def get_chunk_by_index(kb_id: str, doc_id: str, chunk_index: int) -> dict:
    """Fetch a single chunk by doc_id + chunk_index.

    Use this when context_window didn't give enough surrounding context —
    you can request further chunks by incrementing or decrementing chunk_index.
    The response includes prev_exists / next_exists hints so you know whether
    more chunks are available in either direction."""
    db = _get_db()
    try:
        chunk = db.get_chunk_by_index(kb_id, doc_id, chunk_index)
        if chunk is None:
            return {"error": f"Chunk not found: doc={doc_id} index={chunk_index}"}
        return chunk
    finally:
        db.close()


@mcp.tool
def get_chunks_by_page(kb_id: str, doc_id: str, page: int) -> dict:
    """Fetch all chunks on a specific page of a document.

    Use this when you know the page number (from previous search results'
    page_start/page_end fields) and want to read everything on that page.
    Returns all chunks whose page range covers the given page number."""
    db = _get_db()
    try:
        chunks = db.get_chunks_by_page(kb_id, doc_id, page)
        return {
            "kb_id": kb_id,
            "doc_id": doc_id,
            "page": page,
            "chunks": chunks,
            "count": len(chunks),
        }
    finally:
        db.close()


@mcp.tool
def read_document_image(kb_id: str, doc_id: str, image_name: str) -> dict:
    """Read an image from a document and return its absolute file path for display.

    IMAGE WORKFLOW — Follow these steps when you see image chunks in search results:

    1. Search results with content_type='image' refer to images. The chunk
       content looks like: "[Image: abc123.jpg]\\nDescription text..."
    2. Extract the image filename from the chunk content (e.g. "abc123.jpg").
    3. Call this tool with the filename to get the absolute path.
    4. Display the image inline using markdown with the file:// protocol:
       ![description](file://<absolute_path>)

    When you're not sure which image name to use, call with any name — if it
    doesn't exist, the response includes available_images for that document.

    IMPORTANT: Always include images in your answer when the user asks about
    visual content, diagrams, charts, or photos. Images are key information,
    not optional — they supplement your text answer with visual evidence.
    NEVER make up or guess image URLs — always use this tool."""
    doc_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs" / doc_id / "images"
    if not doc_dir.exists():
        return {"error": f"Document or images directory not found: {doc_id}"}

    img_path = doc_dir / image_name
    if not img_path.exists():
        available = sorted([
            p.name for p in doc_dir.iterdir()
            if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"}
        ])
        return {
            "error": f"Image not found: {image_name}",
            "available_images": available,
        }

    ext = img_path.suffix.lower()
    mime_map = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
        ".svg": "image/svg+xml",
    }
    mime_type = mime_map.get(ext, "application/octet-stream")

    try:
        abs_path = str(img_path.resolve())
        return {
            "name": image_name,
            "absolute_path": abs_path,
            "mime_type": mime_type,
            "size_bytes": img_path.stat().st_size,
        }
    except Exception as e:
        return {"error": f"Failed to read image: {e}"}


# ── Entry Point ──

@mcp.tool
def clean_orphans() -> dict:
    """Clean up orphaned data. Removes LanceDB tables not in the registry,
    orphan documents (dirs without metadata.json), and stale .bak files."""
    import shutil

    db = _get_db()
    registry_ids: set[str] = set()
    registry_path = Path(DATA_DIR) / "knowledge_bases.json"
    if registry_path.exists():
        try:
            data = json.loads(registry_path.read_text(encoding="utf-8"))
            for kb in data.get("knowledge_bases", []):
                registry_ids.add(kb["id"])
        except (json.JSONDecodeError, OSError):
            pass

    removed: list[str] = []
    skipped: list[str] = []

    def _try_remove(path: Path, label: str):
        try:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            removed.append(label)
        except OSError as e:
            skipped.append(f"{label}: {e}")

    # 1. Remove LanceDB tables not in registry
    try:
        lancedb_ids = db.list_kb_ids()
        for lid in lancedb_ids:
            if lid not in registry_ids:
                try:
                    db.drop_table(lid)
                    removed.append(f"Removed orphan LanceDB table: {lid}")
                except Exception as e:
                    skipped.append(f"LanceDB table {lid}: {e}")
    finally:
        db.close()

    # 2. Remove orphan documents (dirs without metadata.json)
    for kb_id in registry_ids:
        docs_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs"
        if docs_dir.exists():
            for d in docs_dir.iterdir():
                if d.is_dir() and not (d / "metadata.json").exists():
                    _try_remove(d, f"Removed orphan document: {kb_id}/{d.name}")

    # 3. Remove stale .bak files
    lancedb_dir = Path(DATA_DIR) / "lancedb_data"
    if lancedb_dir.exists():
        for pattern in ["*.bak", "*.bak.*"]:
            for f in lancedb_dir.glob(pattern):
                _try_remove(f, f"Removed stale backup: {f.name}")

    # 4. Repair kb_id mismatches in chunks
    db2 = _get_db()
    try:
        for kb_id in registry_ids:
            table = db2.get_table(kb_id)
            if table is None:
                continue
            try:
                mismatched = table.search().where(f"kb_id != '{kb_id}'").limit(1).to_list()
                if mismatched:
                    all_wrong = table.search().where(f"kb_id != '{kb_id}'").limit(100000).to_list()
                    if all_wrong:
                        table.delete(f"kb_id != '{kb_id}'")
                        for row in all_wrong:
                            row["kb_id"] = kb_id
                        table.add(all_wrong)
                        removed.append(f"Fixed {len(all_wrong)} chunks with wrong kb_id in KB: {kb_id}")
            except Exception:
                pass
    finally:
        db2.close()

    # 5. Remove chunks whose documents no longer have full.md
    db3 = _get_db()
    try:
        for kb_id in registry_ids:
            table = db3.get_table(kb_id)
            if table is None:
                continue
            try:
                docs_dir = Path(DATA_DIR) / f"kb_{kb_id}" / "docs"
                # Use native to_list() — to_pandas() may fail if pandas not installed
                all_rows = table.search().limit(100000).to_list()
                all_doc_ids = set()
                for row in all_rows:
                    did = str(row.get("doc_id", ""))
                    if did:
                        all_doc_ids.add(did)

                dead_docs: list[str] = []
                for did in all_doc_ids:
                    if not (docs_dir / did / "full.md").exists():
                        dead_docs.append(did)

                for did in dead_docs:
                    try:
                        table.delete(f"doc_id = '{did}'")
                        removed.append(f"Removed orphan chunks for doc {did} in KB {kb_id}")
                    except Exception:
                        pass
            except Exception as e:
                skipped.append(f"Orphan check for KB {kb_id}: {e}")
    finally:
        db3.close()

    # 6. Re-count chunks/docs for all KBs
    for kb_id in registry_ids:
        try:
            _update_kb_counts(kb_id)
        except Exception as e:
            skipped.append(f"Count update for {kb_id}: {e}")

    return {"removed": len(removed), "skipped": len(skipped), "removed_items": removed, "skipped_items": skipped}


def main():
    """Entry point for the MCP stdio server."""
    mcp.run(transport="stdio")
