"""Settings validation endpoints."""
import httpx
from fastapi import APIRouter
from pydantic import BaseModel
from urllib.parse import urlparse

router = APIRouter()


@router.get("/llama-status")
def llama_status():
    """Check whether local llama.cpp servers are running (embedding + rerank)."""
    try:
        from ..llama_service import status as llama_status_dict, _find_llama_server
        from ..config import get_config
        config = get_config()

        s = llama_status_dict()
        emb = s["embedding"]
        rer = s["rerank"]
        emb_ok = emb["running"] or emb["starting"]
        rer_ok = rer["running"] or rer["starting"]

        return {
            "running": emb["running"] or rer["running"],
            "starting": emb["starting"] or rer["starting"],
            "embedding": emb,
            "rerank": rer,
            "binary_found": _find_llama_server() is not None,
            "use_local_embedding": config.use_local_embedding,
            "use_local_rerank": config.use_local_rerank,
            "last_error": getattr(config, "_llama_error", ""),
            "message": "Running" if (emb["running"] or rer["running"]) else ("Starting..." if (emb["starting"] or rer["starting"]) else "Not running"),
        }
    except Exception as e:
        return {"running": False, "port": 0, "message": f"Error: {e}"}


class ValidateEmbeddingRequest(BaseModel):
    api_base: str
    api_key: str
    model: str


class ValidateRerankRequest(BaseModel):
    api_base: str
    api_key: str
    model: str


@router.post("/config/validate-embedding")
def validate_embedding(req: ValidateEmbeddingRequest):
    """Test embedding API connectivity. Tries multiple URL patterns."""
    base = req.api_base.rstrip("/")
    is_local = req.api_key == "local"
    headers = {
        "Authorization": f"Bearer {req.api_key}",
        "Content-Type": "application/json",
    }
    body = {"model": req.model, "input": ["test"]}

    # llama.cpp with --pooling mean serves OAI-compatible /v1/embeddings
    paths = ["/v1/embeddings", "/embeddings", "/embedding"]

    last_error = None
    try:
        with httpx.Client(timeout=10.0) as client:
            for path in paths:
                try:
                    resp = client.post(f"{base}{path}", json=body, headers=headers)
                    if resp.status_code == 200:
                        data = resp.json()
                        dim = len(data["data"][0]["embedding"])
                        return {"valid": True, "dimension": dim, "status": "ok"}
                    last_error = f"{base}{path} → HTTP {resp.status_code}: {resp.text[:300]}"
                except Exception as e:
                    last_error = f"{base}{path} → {e}"
                    continue
            return {"valid": False, "status": "all_attempts_failed", "detail": last_error or "No connection"}
    except Exception as e:
        return {"valid": False, "status": "error", "detail": str(e)}


@router.post("/config/validate-rerank")
def validate_rerank(req: ValidateRerankRequest):
    """Test rerank API connectivity. Tries common URL patterns and body formats."""
    base = req.api_base.rstrip("/")
    is_local = "127.0.0.1" in base or "localhost" in base
    headers = {
        "Authorization": f"Bearer {req.api_key}",
        "Content-Type": "application/json",
    }

    attempts = [
        # (url, body, label)
        (f"{base}/rerank", "jina", {
            "model": req.model, "query": "test",
            "documents": ["sample document"], "top_n": 2,
        }),
        (f"{base}/rerank", "cohere", {
            "model": req.model, "query": "test",
            "documents": ["sample document"],
        }),
        (f"{base}", "jina", {
            "model": req.model, "query": "test",
            "documents": ["sample document"], "top_n": 2,
        }),
        (f"{base}", "cohere", {
            "model": req.model, "query": "test",
            "documents": ["sample document"],
        }),
    ]

    # External API fallbacks — skipped for local models
    if not is_local:
        attempts.append(
            (f"https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank", "dashscope", {
                "model": req.model,
                "input": {"query": "test", "documents": ["sample document"]},
                "parameters": {"top_n": 2},
            }),
        )

    # Also try DashScope native on the same host if base URL points to dashscope
    try:
        parsed = urlparse(base)
        if parsed.hostname and "dashscope" in parsed.hostname:
            dashscope_url = f"https://{parsed.hostname}/api/v1/services/rerank/text-rerank/text-rerank"
            if dashscope_url not in [a[0] for a in attempts]:
                attempts.insert(0, (dashscope_url, "dashscope", {
                    "model": req.model,
                    "input": {"query": "test", "documents": ["sample document"]},
                    "parameters": {"top_n": 2},
                }))
    except Exception:
        pass

    last_error = None
    try:
        with httpx.Client(timeout=10.0) as client:
            for url, fmt, body in attempts:
                try:
                    resp = client.post(url, json=body, headers=headers)
                    if resp.status_code == 200:
                        return {"valid": True, "format": fmt, "url": url, "status": "ok"}
                    last_error = f"{url} → HTTP {resp.status_code}: {resp.text[:300]}"
                except Exception as e:
                    last_error = f"{url} → {e}"
                    continue

            return {
                "valid": False,
                "status": "all_attempts_failed",
                "detail": last_error or "No connection could be established",
            }
    except Exception as e:
        return {"valid": False, "status": "error", "detail": str(e)}


@router.post("/config/validate-vlm")
def validate_vlm(req: ValidateEmbeddingRequest):
    """Test VLM API connectivity with a minimal chat request."""
    base = req.api_base.rstrip("/")
    headers = {"Authorization": f"Bearer {req.api_key}", "Content-Type": "application/json"}
    body = {"model": req.model, "messages": [{"role": "user", "content": "Reply: ok"}], "max_tokens": 5}
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(f"{base}/chat/completions", json=body, headers=headers)
            if resp.status_code == 200:
                return {"valid": True, "status": "ok"}
            return {"valid": False, "status": f"HTTP {resp.status_code}", "detail": resp.text[:300]}
    except Exception as e:
        return {"valid": False, "status": "error", "detail": str(e)}


@router.post("/config/validate-llm")
def validate_llm(req: ValidateEmbeddingRequest):
    """Test LLM (Chat) API connectivity."""
    base = req.api_base.rstrip("/")
    headers = {"Authorization": f"Bearer {req.api_key}", "Content-Type": "application/json"}
    body = {"model": req.model, "messages": [{"role": "user", "content": "Reply: ok"}], "max_tokens": 5}
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(f"{base}/chat/completions", json=body, headers=headers)
            if resp.status_code == 200:
                return {"valid": True, "status": "ok"}
            return {"valid": False, "status": f"HTTP {resp.status_code}", "detail": resp.text[:300]}
    except Exception as e:
        return {"valid": False, "status": "error", "detail": str(e)}
