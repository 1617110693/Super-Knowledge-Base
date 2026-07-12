"""Search endpoint."""
import json
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from ..config import get_config
from ..db.lancedb_manager import LanceDBManager
from ..embedding import OpenAICompatibleEmbedder
from ..reranker import OpenAICompatibleReranker

router = APIRouter()


class SearchRequest(BaseModel):
    kb_id: str
    query: str
    search_type: str = "hybrid"
    top_k: int = 10
    rerank: bool = True
    context_window: int = 0
    filters: Optional[dict] = None


@router.post("/search")
def search(req: SearchRequest):
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")

    try:
        start = time.time()

        embedder = OpenAICompatibleEmbedder(
            config.embedding_api_base,
            config.embedding_api_key,
            config.embedding_model,
        )
        query_vector = embedder.embed_single(req.query)
        embedder.close()

        doc_filter = req.filters.get("doc_id") if req.filters else None
        fetch_k = req.top_k * 3 if req.rerank else req.top_k

        results = db.search(
            kb_id=req.kb_id,
            query_vector=query_vector,
            query_text=req.query,
            search_type=req.search_type,
            top_k=fetch_k,
            doc_id_filter=doc_filter,
        )

        if req.rerank and results and config.rerank_api_key:
            try:
                reranker = OpenAICompatibleReranker(
                    config.rerank_api_base,
                    config.rerank_api_key,
                    config.rerank_model,
                )
                documents = [r["content"] for r in results]
                reranked = reranker.rerank(req.query, documents, top_n=req.top_k)
                reranker.close()

                new_results = []
                for rr in reranked[: req.top_k]:
                    if rr.index < len(results):
                        r = results[rr.index]
                        if len(r.get("content", "").strip()) >= 20:
                            r["score"] = rr.score
                            new_results.append(r)
                results = new_results
            except Exception:
                results = [r for r in results[: req.top_k] if len(r.get("content", "").strip()) >= 20]
        else:
            results = [r for r in results[: req.top_k] if len(r.get("content", "").strip()) >= 20]

        # Enrich with neighboring chunks if context_window > 0
        if req.context_window > 0 and results:
            results = db.enrich_with_context(results, req.kb_id, req.context_window)

        elapsed = int((time.time() - start) * 1000)

        return {"results": results, "total": len(results), "search_time_ms": elapsed}
    finally:
        db.close()


class SearchDocumentRequest(BaseModel):
    kb_id: str
    doc_id: str
    query: str
    search_type: str = "hybrid"
    top_k: int = 10
    rerank: bool = True
    context_window: int = 0


@router.post("/search-document")
def search_document(req: SearchDocumentRequest):
    """Search within a single document."""
    from fastapi import HTTPException
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")

    try:
        start = time.time()

        embedder = OpenAICompatibleEmbedder(
            config.embedding_api_base,
            config.embedding_api_key,
            config.embedding_model,
        )
        query_vector = embedder.embed_single(req.query)
        embedder.close()

        fetch_k = req.top_k * 3 if req.rerank else req.top_k

        results = db.search(
            kb_id=req.kb_id,
            query_vector=query_vector,
            query_text=req.query,
            search_type=req.search_type,
            top_k=fetch_k,
            doc_id_filter=req.doc_id,
        )

        if req.rerank and results and config.rerank_api_key:
            try:
                reranker = OpenAICompatibleReranker(
                    config.rerank_api_base,
                    config.rerank_api_key,
                    config.rerank_model,
                )
                documents = [r["content"] for r in results]
                reranked = reranker.rerank(req.query, documents, top_n=req.top_k)
                reranker.close()

                new_results = []
                for rr in reranked[: req.top_k]:
                    if rr.index < len(results):
                        r = results[rr.index]
                        if len(r.get("content", "").strip()) >= 20:
                            r["score"] = rr.score
                            new_results.append(r)
                results = new_results
            except Exception:
                results = [r for r in results[: req.top_k] if len(r.get("content", "").strip()) >= 20]
        else:
            results = [r for r in results[: req.top_k] if len(r.get("content", "").strip()) >= 20]

        if req.context_window > 0 and results:
            results = db.enrich_with_context(results, req.kb_id, req.context_window)

        elapsed = int((time.time() - start) * 1000)
        return {"results": results, "total": len(results), "search_time_ms": elapsed}
    finally:
        db.close()


class SearchAllRequest(BaseModel):
    kb_ids: Optional[list[str]] = None
    query: str
    search_type: str = "hybrid"
    top_k: int = 10
    rerank: bool = True
    context_window: int = 0


@router.post("/search-all")
def search_all(req: SearchAllRequest):
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")

    try:
        start = time.time()

        embedder = OpenAICompatibleEmbedder(
            config.embedding_api_base,
            config.embedding_api_key,
            config.embedding_model,
        )
        query_vector = embedder.embed_single(req.query)
        embedder.close()

        # Determine which KBs to search
        available_kb_ids = db.list_kb_ids()
        if req.kb_ids:
            target_kb_ids = [k for k in req.kb_ids if k in available_kb_ids]
        else:
            target_kb_ids = available_kb_ids

        if not target_kb_ids:
            return {"results": [], "total": 0, "search_time_ms": 0}

        fetch_k = req.top_k * 3 if req.rerank else req.top_k
        per_kb = max(fetch_k // max(len(target_kb_ids), 1), 3)

        all_results = []
        for kb_id in target_kb_ids:
            try:
                kb_results = db.search(
                    kb_id=kb_id,
                    query_vector=query_vector,
                    query_text=req.query,
                    search_type=req.search_type,
                    top_k=per_kb,
                )
                all_results.extend(kb_results)
            except Exception:
                continue

        # Sort by score descending
        all_results.sort(key=lambda x: x.get("score", 0), reverse=True)

        # Optional rerank across all results
        if req.rerank and all_results and config.rerank_api_key:
            try:
                reranker = OpenAICompatibleReranker(
                    config.rerank_api_base,
                    config.rerank_api_key,
                    config.rerank_model,
                )
                documents = [r["content"] for r in all_results]
                reranked = reranker.rerank(req.query, documents, top_n=req.top_k)
                reranker.close()

                new_results = []
                for rr in reranked[: req.top_k]:
                    if rr.index < len(all_results):
                        r = all_results[rr.index]
                        if len(r.get("content", "").strip()) >= 20:
                            r["score"] = rr.score
                            new_results.append(r)
                all_results = new_results
            except Exception:
                all_results = [r for r in all_results[: req.top_k] if len(r.get("content", "").strip()) >= 20]
        else:
            all_results = [r for r in all_results[: req.top_k] if len(r.get("content", "").strip()) >= 20]

        # Enrich with neighboring chunks if context_window > 0
        if req.context_window > 0 and all_results:
            # Group by kb_id and enrich each group separately
            by_kb: dict[str, list[dict]] = {}
            for r in all_results:
                kb = r.get("kb_id", "")
                by_kb.setdefault(kb, []).append(r)
            enriched = []
            for kb_id, group in by_kb.items():
                enriched.extend(db.enrich_with_context(group, kb_id, req.context_window))
            all_results = enriched

        elapsed = int((time.time() - start) * 1000)

        return {"results": all_results, "total": len(all_results), "search_time_ms": elapsed}
    finally:
        db.close()


class GetChunkRequest(BaseModel):
    kb_id: str
    doc_id: str
    chunk_index: int


class GetChunkRangeRequest(BaseModel):
    kb_id: str
    doc_id: str
    start: int = 0
    end: int = 50


@router.post("/get-chunk-range")
def get_chunk_range(req: GetChunkRangeRequest):
    """Fetch chunks in a range [start, end] for a document, sorted by chunk_index."""
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")
    try:
        chunks = db.get_chunk_range(req.kb_id, req.doc_id, req.start, req.end)
        return {"kb_id": req.kb_id, "doc_id": req.doc_id, "chunks": chunks, "start": req.start, "end": req.end}
    finally:
        db.close()


@router.post("/get-chunk-by-index")
def get_chunk_by_index(req: GetChunkRequest):
    """Fetch a single chunk by doc_id + chunk_index, with prev/next existence hints."""
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")
    try:
        chunk = db.get_chunk_by_index(req.kb_id, req.doc_id, req.chunk_index)
        if chunk is None:
            return {"error": f"Chunk not found: doc={req.doc_id} index={req.chunk_index}"}
        return {"chunk": chunk}
    finally:
        db.close()


class DuckDuckGoSearchRequest(BaseModel):
    query: str
    max_results: int = 5
    proxy: str = ""


@router.post("/duckduckgo-search")
def duckduckgo_search(req: DuckDuckGoSearchRequest):
    """Search via DuckDuckGo using the duckduckgo_search library."""
    from duckduckgo_search import DDGS

    config = get_config()
    proxy = req.proxy or config.web_search_proxy or None

    try:
        ddgs = DDGS(proxy=proxy, timeout=20)
        results = list(ddgs.text(req.query, max_results=min(req.max_results, 10)))
        return {
            "results": [
                {"title": r["title"], "url": r.get("href", ""), "content": r.get("body", "")}
                for r in results
            ],
            "total": len(results),
        }
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail=f"DuckDuckGo search failed: {e}")


class BingSearchRequest(BaseModel):
    query: str
    max_results: int = 5


@router.post("/bing-search")
def bing_search(req: BingSearchRequest):
    """Search via Bing CN using a Node.js child process.
    Node.js is used because Bing's edge-CDN identifies Python/rustls TLS
    fingerprints as non-browser traffic and redirects to the homepage."""
    script = Path(__file__).parent.parent / "bing_search.js"
    if not script.exists():
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"Bing search script not found: {script}")
    try:
        proc = subprocess.run(
            ["node", str(script), req.query, str(min(req.max_results, 10))],
            capture_output=True, timeout=20,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", errors="replace").strip())
        results = json.loads(proc.stdout.decode("utf-8"))
        return {"results": results, "total": len(results)}
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail=f"Bing search failed: {e}")
