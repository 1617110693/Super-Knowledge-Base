"""Document indexing and deletion endpoints."""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..config import get_config
from ..db.lancedb_manager import LanceDBManager
from ..embedding import OpenAICompatibleEmbedder
from ..chunker import Chunker

router = APIRouter()


class IndexRequest(BaseModel):
    kb_id: str
    doc_id: str
    doc_name: str = ""
    markdown_content: str
    chunk_config: Optional[dict] = None


class DeleteChunksRequest(BaseModel):
    kb_id: str
    doc_id: str


@router.post("/index")
def index_document(req: IndexRequest):
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")

    try:
        embedder = OpenAICompatibleEmbedder(
            config.embedding_api_base,
            config.embedding_api_key,
            config.embedding_model,
        )
        embedding_dim = embedder.get_dimension()

        if not db.table_exists(req.kb_id):
            db.create_table(req.kb_id, embedding_dim)

        chunk_config = req.chunk_config or {}
        strategy = chunk_config.get("strategy", config.chunk_strategy)
        chunk_size = chunk_config.get("chunk_size", config.chunk_size)
        chunk_overlap = chunk_config.get("chunk_overlap", config.chunk_overlap)

        chunker = Chunker.create(strategy, chunk_size, chunk_overlap)
        chunks = chunker.chunk(
            req.markdown_content,
            metadata={"doc_id": req.doc_id, "doc_name": req.doc_name},
        )

        if not chunks:
            return {"doc_id": req.doc_id, "chunk_count": 0, "status": "no_content"}

        texts = [c.content for c in chunks]
        vectors = embedder.embed(texts)
        embedder.close()

        count = db.insert_chunks(
            kb_id=req.kb_id,
            chunks=chunks,
            vectors=vectors,
            doc_id=req.doc_id,
            doc_name=req.doc_name or req.doc_id,
            chunk_strategy=strategy,
        )

        return {
            "doc_id": req.doc_id,
            "chunk_count": count,
            "status": "indexed",
            "embedding_model": config.embedding_model,
            "embedding_dim": embedding_dim,
        }
    finally:
        db.close()


@router.post("/delete-chunks")
def delete_document_chunks(req: DeleteChunksRequest):
    """Delete all chunks belonging to a document from LanceDB."""
    config = get_config()
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")
    try:
        db.delete_document_chunks(req.kb_id, req.doc_id)
        return {"status": "ok", "doc_id": req.doc_id}
    finally:
        db.close()
