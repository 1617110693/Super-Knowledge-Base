"""Settings validation endpoints."""
import httpx
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


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
    """Test embedding API connectivity."""
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(
                f"{req.api_base}/v1/embeddings",
                json={"model": req.model, "input": ["test"]},
                headers={
                    "Authorization": f"Bearer {req.api_key}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                dim = len(data["data"][0]["embedding"])
                return {"valid": True, "dimension": dim, "status": "ok"}
            return {
                "valid": False,
                "status": f"HTTP {resp.status_code}",
                "detail": resp.text[:500],
            }
    except Exception as e:
        return {"valid": False, "status": "error", "detail": str(e)}


@router.post("/config/validate-rerank")
def validate_rerank(req: ValidateRerankRequest):
    """Test rerank API connectivity."""
    try:
        with httpx.Client(timeout=10.0) as client:
            # Try Jina-style
            resp = client.post(
                f"{req.api_base}/v1/rerank",
                json={
                    "model": req.model,
                    "query": "test",
                    "documents": ["sample document"],
                },
                headers={
                    "Authorization": f"Bearer {req.api_key}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code == 200:
                return {"valid": True, "format": "jina", "status": "ok"}
            # Try Cohere-style
            resp = client.post(
                f"{req.api_base}/rerank",
                json={
                    "model": req.model,
                    "query": "test",
                    "documents": ["sample document"],
                },
                headers={
                    "Authorization": f"Bearer {req.api_key}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code == 200:
                return {"valid": True, "format": "cohere", "status": "ok"}
            return {
                "valid": False,
                "status": "unknown_format",
                "detail": "Neither Jina nor Cohere format accepted",
            }
    except Exception as e:
        return {"valid": False, "status": "error", "detail": str(e)}
