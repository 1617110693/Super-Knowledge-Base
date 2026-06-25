"""Search endpoint."""
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
                        results[rr.index]["score"] = rr.score
                        new_results.append(results[rr.index])
                results = new_results
            except Exception:
                results = results[: req.top_k]
        else:
            results = results[: req.top_k]

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
                        all_results[rr.index]["score"] = rr.score
                        new_results.append(all_results[rr.index])
                all_results = new_results
            except Exception:
                all_results = all_results[: req.top_k]
        else:
            all_results = all_results[: req.top_k]

        elapsed = int((time.time() - start) * 1000)

        return {"results": all_results, "total": len(all_results), "search_time_ms": elapsed}
    finally:
        db.close()
