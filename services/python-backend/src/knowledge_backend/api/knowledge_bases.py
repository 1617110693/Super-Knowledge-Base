"""Knowledge base management endpoints."""
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import get_config
from ..db.lancedb_manager import LanceDBManager

router = APIRouter()


class CreateKBRequest(BaseModel):
    kb_id: str
    embedding_dim: int = 1536


class BackupKBRequest(BaseModel):
    kb_id: str


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


@router.post("/kb/{kb_id}/backup")
def backup_kb(kb_id: str):
    """Create a backup of the LanceDB table before re-indexing."""
    config = get_config()
    lancedb_dir = Path(config.knowledge_base_data_dir) / "lancedb_data"
    table_name = LanceDBManager.table_name(kb_id)
    table_path = lancedb_dir / f"{table_name}.lance"

    if not table_path.exists():
        raise HTTPException(404, f"Table not found: {table_name}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_path = lancedb_dir / f"{table_name}.lance.{timestamp}.bak"
    shutil.copytree(table_path, backup_path)

    return {"kb_id": kb_id, "backup_path": str(backup_path), "status": "backed_up"}
