"""Document indexing and deletion endpoints."""
from pathlib import Path
import base64

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..config import get_config
from ..db.lancedb_manager import LanceDBManager
from ..embedding import OpenAICompatibleEmbedder
from ..chunker import Chunker
from ..page_mapper import PageMapper

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

        # Build page mapper from MinerU JSON if available
        doc_dir = Path(config.knowledge_base_data_dir) / f"kb_{req.kb_id}" / "docs" / req.doc_id
        page_mapper = PageMapper.from_doc_dir(doc_dir, req.markdown_content)

        chunker = Chunker.create(strategy, chunk_size, chunk_overlap)
        chunks = chunker.chunk(
            req.markdown_content,
            metadata={"doc_id": req.doc_id, "doc_name": req.doc_name},
            page_mapper=page_mapper,
        )

        # Generate multimodal chunks + VLM descriptions if content_list.json exists
        mm_chunks = []
        cl_path = doc_dir / "content_list.json"
        if cl_path.exists() and config.extract_multimodal:
            try:
                import json as _json
                from ..page_mapper import extract_multimodal_items
                from ..chunker import multimodal_chunks_from_content_list
                cl_data = _json.loads(cl_path.read_text(encoding="utf-8"))
                mm_items = extract_multimodal_items(cl_data)
                image_descriptions: dict[str, tuple[str, dict]] = {}
                has_vlm = bool(config.vlm_api_base.strip() and config.vlm_model.strip())
                if has_vlm:
                    from ..vision import describe_image
                    import httpx
                    img_dir = doc_dir / "images"
                    http = httpx.Client(timeout=60.0)
                    try:
                        for mi in mm_items:
                            if mi["type"] != "image":
                                continue
                            img_name = mi.get("img_path", "").split("/")[-1]
                            if not img_name:
                                continue
                            img_file = img_dir / img_name
                            if not img_file.exists():
                                continue
                            fmt = img_file.suffix.lstrip(".") or "png"
                            try:
                                desc, entity = describe_image(
                                    img_file.read_bytes(), fmt,
                                    vlm_api_base=config.vlm_api_base,
                                    vlm_api_key=config.vlm_api_key,
                                    vlm_model=config.vlm_model,
                                    caption=mi.get("text", ""),
                                    http=http,
                                )
                                image_descriptions[img_name] = (desc, entity)
                                _save_image_meta(doc_dir, img_name, desc, entity)
                            except Exception as e:
                                import sys
                                print(f"[index] VLM failed for {img_name}: {e}", file=sys.stderr)
                                # Save fallback description so UI doesn't show "No description"
                                caption = mi.get("text", "")
                                _save_image_meta(doc_dir, img_name, caption or "Image", {"entity_name": img_name, "entity_type": "image", "summary": caption})
                    finally:
                        http.close()
                mm_chunks = multimodal_chunks_from_content_list(
                    mm_items,
                    metadata={"doc_id": req.doc_id, "doc_name": req.doc_name},
                    image_descriptions=image_descriptions if image_descriptions else None,
                )
            except Exception as e:
                import sys
                print(f"[index] multimodal generation failed: {e}", file=sys.stderr)

        all_chunks = chunks + mm_chunks

        if not all_chunks:
            return {
                "doc_id": req.doc_id,
                "chunk_count": 0,
                "status": "no_content",
                "embedding_model": config.embedding_model,
                "embedding_dim": embedding_dim,
            }

        texts = [c.content for c in all_chunks]
        vectors = embedder.embed(texts)
        embedder.close()

        count = db.insert_chunks(
            kb_id=req.kb_id,
            chunks=all_chunks,
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


class DescribeImageRequest(BaseModel):
    kb_id: str
    doc_id: str
    filename: str


@router.post("/images/describe")
def describe_image(req: DescribeImageRequest):
    """Re-run VLM on a document image. Returns AI-generated description."""
    config = get_config()
    if not config.vlm_api_base.strip() or not config.vlm_model.strip():
        raise HTTPException(400, "VLM not configured")
    img_path = (
        Path(config.knowledge_base_data_dir)
        / f"kb_{req.kb_id}" / "docs" / req.doc_id
        / "images" / req.filename
    )
    if not img_path.exists():
        raise HTTPException(404, "Image not found")
    from ..vision import describe_image
    import httpx
    fmt = img_path.suffix.lstrip(".") or "png"
    img_bytes = img_path.read_bytes()
    with httpx.Client(timeout=60.0) as http:
        desc, entity = describe_image(
            img_bytes, fmt,
            vlm_api_base=config.vlm_api_base,
            vlm_api_key=config.vlm_api_key,
            vlm_model=config.vlm_model,
            http=http,
        )
    return {"description": desc, "entity_info": entity, "status": "ok"}


def _save_image_meta(doc_dir: Path, filename: str, description: str, entity_info: dict):
    """Save image description to images_meta.json for the UI to read."""
    import json as _json
    meta_path = doc_dir / "images_meta.json"
    meta = {}
    if meta_path.exists():
        try:
            meta = _json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    meta[filename] = {
        "description": description,
        "entity_info": entity_info,
        "generated_at": __import__("datetime").datetime.now().isoformat(),
    }
    meta_path.write_text(_json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
