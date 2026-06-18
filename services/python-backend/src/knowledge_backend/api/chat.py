"""Chat/RAG endpoint."""
import json
from pathlib import Path

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List

from ..config import get_config
from ..db.lancedb_manager import LanceDBManager
from ..embedding import OpenAICompatibleEmbedder
from ..reranker import OpenAICompatibleReranker

router = APIRouter()


class ChatRequest(BaseModel):
    kb_id: str
    question: str
    top_k: int = 5
    rerank: bool = True
    include_sources: bool = True
    chat_history: List[dict] = []
    stream: bool = False


@router.post("/chat")
async def chat(req: ChatRequest):
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")

    try:
        embedder = OpenAICompatibleEmbedder(
            config.embedding_api_base,
            config.embedding_api_key,
            config.embedding_model,
        )
        query_vector = embedder.embed_single(req.question)
        embedder.close()

        results = db.search(
            kb_id=req.kb_id,
            query_vector=query_vector,
            query_text=req.question,
            search_type="hybrid",
            top_k=req.top_k * 3 if req.rerank else req.top_k,
        )

        if req.rerank and results and config.rerank_api_key:
            try:
                reranker = OpenAICompatibleReranker(
                    config.rerank_api_base,
                    config.rerank_api_key,
                    config.rerank_model,
                )
                documents = [r["content"] for r in results]
                reranked = reranker.rerank(req.question, documents, top_n=req.top_k)
                reranker.close()
                results = [results[rr.index] for rr in reranked[: req.top_k]]
            except Exception:
                results = results[: req.top_k]
        else:
            results = results[: req.top_k]

        context = "\n\n---\n\n".join(
            [f"Source: {r['doc_name']}\n{r['content']}" for r in results]
        )

        system_prompt = f"""You are a helpful AI assistant answering questions based on the provided knowledge base.

Use the following context from the knowledge base to answer the user's question. If the context doesn't contain relevant information, say so.

Context:
{context}

Answer the question based on the context above. Include citations referencing the source documents where possible."""

        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(req.chat_history)
        messages.append({"role": "user", "content": req.question})

        if req.stream:
            return StreamingResponse(
                _stream_chat(config, messages, results if req.include_sources else []),
                media_type="text/event-stream",
            )
        else:
            answer = _call_llm(config, messages)
            return {
                "answer": answer,
                "sources": results if req.include_sources else [],
            }
    finally:
        db.close()


async def _stream_chat(config, messages, sources):
    """Stream the LLM response as SSE."""
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            if sources:
                yield f"data: {json.dumps({'type': 'sources', 'chunks': sources})}\n\n"

            body = {"model": config.llm_model, "messages": messages, "stream": True}
            headers = {
                "Authorization": f"Bearer {config.llm_api_key}",
                "Content-Type": "application/json",
            }

            async with client.stream(
                "POST",
                f"{config.llm_api_base}/v1/chat/completions",
                json=body,
                headers=headers,
            ) as resp:
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        data = line[6:]
                        if data == "[DONE]":
                            yield f"data: {json.dumps({'type': 'done'})}\n\n"
                            break
                        try:
                            chunk = json.loads(data)
                            content = (
                                chunk.get("choices", [{}])[0]
                                .get("delta", {})
                                .get("content", "")
                            )
                            if content:
                                yield f"data: {json.dumps({'type': 'token', 'content': content})}\n\n"
                        except json.JSONDecodeError:
                            continue
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"


def _call_llm(config, messages) -> str:
    """Make a synchronous LLM call."""
    with httpx.Client(timeout=120.0) as client:
        body = {"model": config.llm_model, "messages": messages}
        headers = {
            "Authorization": f"Bearer {config.llm_api_key}",
            "Content-Type": "application/json",
        }
        resp = client.post(
            f"{config.llm_api_base}/v1/chat/completions",
            json=body,
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
