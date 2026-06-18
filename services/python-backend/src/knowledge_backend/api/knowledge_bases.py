"""Knowledge base management endpoints."""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import get_config
from ..db.lancedb_manager import LanceDBManager

router = APIRouter()


class CreateKBRequest(BaseModel):
    kb_id: str
    embedding_dim: int = 1536


@router.post("/kb")
def create_kb(req: CreateKBRequest):
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")
    try:
        if db.table_exists(req.kb_id):
            raise HTTPException(409, "Knowledge base already exists")
        db.create_table(req.kb_id, req.embedding_dim)
        return {"kb_id": req.kb_id, "status": "created"}
    finally:
        db.close()


@router.delete("/kb/{kb_id}")
def delete_kb(kb_id: str):
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")
    try:
        if not db.table_exists(kb_id):
            raise HTTPException(404, "Knowledge base not found")
        db.drop_table(kb_id)
        return {"kb_id": kb_id, "status": "deleted"}
    finally:
        db.close()


@router.get("/kb/{kb_id}/stats")
def get_kb_stats(kb_id: str):
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")
    try:
        return db.get_kb_stats(kb_id)
    finally:
        db.close()
