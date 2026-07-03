"""Document indexing and deletion endpoints."""
from pathlib import Path
import base64
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..config import get_config
from ..db.lancedb_manager import LanceDBManager
from ..embedding import OpenAICompatibleEmbedder
from ..chunker import Chunker
from ..page_mapper import PageMapper

router = APIRouter()

# ── Index progress tracking ──

_index_tasks: dict[str, dict] = {}
_index_tasks_lock = threading.Lock()
_seq_counter = 0  # monotonic sequence for all progress updates

# Weight ranges for each stage (monotonically increasing)
_STAGE_WEIGHTS = {
    "chunking": (0, 5),
    "vlm": (5, 25),
    "embedding": (25, 95),
    "storing": (95, 100),
}


def _weighted_percent(stage: str, current: int, total: int) -> int:
    """Compute monotonically increasing percentage across stages."""
    lo, hi = _STAGE_WEIGHTS.get(stage, (0, 0))
    if total > 0:
        return lo + round((current / total) * (hi - lo))
    return lo


def _set_progress(task_id: str, stage: str, current: int, total: int, **extra):
    """Update progress for an indexing task.  Skips updates that would
    regress the percent (defence against out-of-order or stale calls)."""
    global _seq_counter
    with _index_tasks_lock:
        _seq_counter += 1
        pct = _weighted_percent(stage, current, total)
        prev = _index_tasks.get(task_id)
        if prev and not prev.get("done") and pct < prev.get("percent", -1):
            return  # never regress
        _index_tasks[task_id] = {
            "stage": stage,
            "current": current,
            "total": total,
            "percent": pct,
            "seq": _seq_counter,
            "done": False,
            **extra,
        }


def _mark_done(task_id: str, chunk_count: int = 0, embedding_model: str = "", embedding_dim: int = 0):
    with _index_tasks_lock:
        _index_tasks[task_id] = {
            "stage": "done",
            "current": 0,
            "total": 0,
            "percent": 100,
            "done": True,
            "chunk_count": chunk_count,
            "embedding_model": embedding_model,
            "embedding_dim": embedding_dim,
        }


def _mark_failed(task_id: str, error: str):
    with _index_tasks_lock:
        _index_tasks[task_id] = {
            "stage": "error",
            "current": 0,
            "total": 0,
            "percent": 0,
            "done": True,
            "error": error,
        }


def _run_index(req: "IndexRequest", task_id: str):
    """Background indexing worker."""
    config = get_config()
    try:
        _set_progress(task_id, "chunking", 0, 0)

        embedder = OpenAICompatibleEmbedder(
            config.embedding_api_base,
            config.embedding_api_key,
            config.embedding_model,
        )
        embedding_dim = embedder.get_dimension()

        db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")
        if not db.table_exists(req.kb_id):
            db.create_table(req.kb_id, embedding_dim)

        chunk_config = req.chunk_config or {}
        strategy = chunk_config.get("strategy", config.chunk_strategy)
        chunk_size = chunk_config.get("chunk_size", config.chunk_size)
        chunk_overlap = chunk_config.get("chunk_overlap", config.chunk_overlap)

        doc_dir = Path(config.knowledge_base_data_dir) / f"kb_{req.kb_id}" / "docs" / req.doc_id
        page_mapper = PageMapper.from_doc_dir(doc_dir, req.markdown_content)

        chunker = Chunker.create(strategy, chunk_size, chunk_overlap)
        chunks = chunker.chunk(
            req.markdown_content,
            metadata={"doc_id": req.doc_id, "doc_name": req.doc_name},
            page_mapper=page_mapper,
        )

        # ── Multimodal chunks + VLM ──
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
                has_vlm = config.vlm_enabled and bool(config.vlm_api_base.strip() and config.vlm_model.strip())
                image_count = sum(1 for mi in mm_items if mi["type"] == "image")
                if has_vlm and image_count > 0:
                    from ..vision import describe_image
                    import httpx
                    from concurrent.futures import ThreadPoolExecutor, as_completed
                    img_dir = doc_dir / "images"
                    cached_meta = _load_image_meta(doc_dir)
                    cached_count = 0
                    vlm_done = 0
                    vlm_lock = threading.Lock()
                    new_meta_entries: dict[str, tuple[str, dict]] = {}

                    # Separate cached from pending
                    pending: list[dict] = []
                    for mi in mm_items:
                        if mi["type"] != "image":
                            continue
                        img_name = mi.get("img_path", "").split("/")[-1]
                        if not img_name:
                            continue
                        if not (img_dir / img_name).exists():
                            continue
                        if _is_valid_description(cached_meta.get(img_name, {}).get("description", "")):
                            cached = cached_meta[img_name]
                            image_descriptions[img_name] = (cached["description"], cached.get("entity_info", {}))
                            vlm_done += 1
                            cached_count += 1
                            _set_progress(task_id, "vlm", vlm_done, image_count)
                        else:
                            pending.append(mi)

                    # Process pending images concurrently
                    if pending:
                        def _describe_one(mi: dict, api_base: str, api_key: str, model: str) -> tuple[str, str, dict]:
                            img_name = mi.get("img_path", "").split("/")[-1]
                            img_file = img_dir / img_name
                            fmt = img_file.suffix.lstrip(".") or "png"
                            caption = mi.get("text", "")
                            with httpx.Client(timeout=60.0) as client:
                                return describe_image(
                                    img_file.read_bytes(), fmt,
                                    vlm_api_base=api_base, vlm_api_key=api_key,
                                    vlm_model=model, caption=caption, http=client,
                                )

                        workers = min(max(1, config.vlm_concurrency), len(pending))
                        with ThreadPoolExecutor(max_workers=workers) as executor:
                            futures = {
                                executor.submit(
                                    _describe_one, mi,
                                    config.vlm_api_base, config.vlm_api_key, config.vlm_model,
                                ): mi
                                for mi in pending
                            }
                            for future in as_completed(futures):
                                mi = futures[future]
                                img_name = mi.get("img_path", "").split("/")[-1]
                                try:
                                    desc, entity = future.result()
                                except Exception as e:
                                    import sys
                                    print(f"[index] VLM failed for {img_name}: {e}", file=sys.stderr)
                                    caption = mi.get("text", "")
                                    desc = caption or "Image"
                                    entity = {"entity_name": img_name, "entity_type": "image", "summary": caption}
                                image_descriptions[img_name] = (desc, entity)
                                new_meta_entries[img_name] = (desc, entity)
                                with vlm_lock:
                                    vlm_done += 1
                                    _set_progress(task_id, "vlm", vlm_done, image_count)

                    # Write all descriptions at once
                    if new_meta_entries:
                        _save_image_meta_batch(doc_dir, new_meta_entries)
                    if cached_count > 0:
                        import sys
                        print(f"[index] Reused {cached_count} cached VLM descriptions", file=sys.stderr)
                # Transition: VLM done → preparing multimodal chunks + embedding
                _set_progress(task_id, "embedding", 0, 0)
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
            _mark_done(task_id, 0, config.embedding_model, embedding_dim)
            return

        # ── Embedding with progress ──
        texts = [c.content for c in all_chunks]
        total = len(texts)
        batch_size = 50
        all_vectors = []

        for i in range(0, total, batch_size):
            batch = texts[i:i + batch_size]
            batch_vecs = embedder.embed(batch)
            all_vectors.extend(batch_vecs)
            embedded = min(i + batch_size, total)
            _set_progress(task_id, "embedding", embedded, total)

        embedder.close()

        # ── Store ──
        _set_progress(task_id, "storing", 0, 0)
        count = db.insert_chunks(
            kb_id=req.kb_id,
            chunks=all_chunks,
            vectors=all_vectors,
            doc_id=req.doc_id,
            doc_name=req.doc_name or req.doc_id,
            chunk_strategy=strategy,
        )
        db.close()

        _mark_done(task_id, count, config.embedding_model, embedding_dim)

    except Exception as e:
        import sys, traceback
        print(f"[index] task {task_id} failed: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        _mark_failed(task_id, str(e))


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
    """Start an indexing task in the background. Returns task_id for progress polling."""
    task_id = str(uuid.uuid4())
    with _index_tasks_lock:
        _index_tasks[task_id] = {
            "stage": "starting",
            "current": 0,
            "total": 0,
            "percent": 0,
            "done": False,
        }

    thread = threading.Thread(target=_run_index, args=(req, task_id), daemon=True)
    thread.start()

    return {"task_id": task_id, "status": "started"}


@router.get("/index/progress/{task_id}")
def index_progress(task_id: str):
    """Poll the progress of a background indexing task."""
    with _index_tasks_lock:
        task = _index_tasks.get(task_id)
    if task is None:
        raise HTTPException(404, f"Task not found: {task_id}")
    return task


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


def _load_image_meta(doc_dir: Path) -> dict:
    """Load images_meta.json, returning {} if missing or corrupt."""
    import json as _json
    meta_path = doc_dir / "images_meta.json"
    if not meta_path.exists():
        return {}
    try:
        return _json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _is_valid_description(desc: str) -> bool:
    """Check whether a cached description is worth reusing (not empty, not fallback)."""
    if not desc or not desc.strip():
        return False
    # Skip fallback markers — these are placeholders, not real descriptions
    if desc.strip() in (
        "[Image - no description available]",
        "[Image - re-analyze to generate description]",
        "Image",
    ):
        return False
    return True


def _save_image_meta(doc_dir: Path, filename: str, description: str, entity_info: dict):
    """Save a single image description (used by manual re-analyze)."""
    _save_image_meta_batch(doc_dir, {filename: (description, entity_info)})


def _save_image_meta_batch(doc_dir: Path, entries: dict[str, tuple[str, dict]]):
    """Batch-save image descriptions to images_meta.json (single read + single write)."""
    import json as _json
    meta_path = doc_dir / "images_meta.json"
    meta = {}
    if meta_path.exists():
        try:
            meta = _json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    now = __import__("datetime").datetime.now().isoformat()
    for filename, (description, entity_info) in entries.items():
        meta[filename] = {
            "description": description,
            "entity_info": entity_info,
            "generated_at": now,
        }
    meta_path.write_text(_json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")


@router.post("/clean-orphan-chunks")
def clean_orphan_chunks():
    """Remove LanceDB chunks whose documents no longer have full.md."""
    import json as _json
    config = get_config()
    data_dir = Path(config.knowledge_base_data_dir)
    db = LanceDBManager(data_dir / "lancedb_data")

    # Get all KBs from registry
    registry_path = data_dir / "knowledge_bases.json"
    kb_ids: list[str] = []
    if registry_path.exists():
        try:
            reg = _json.loads(registry_path.read_text(encoding="utf-8"))
            kb_ids = [kb["id"] for kb in reg.get("knowledge_bases", [])]
        except Exception:
            pass

    total_removed = 0
    details: list[str] = []

    for kid in kb_ids:
        table = db.get_table(kid)
        if table is None:
            continue
        try:
            docs_dir = data_dir / f"kb_{kid}" / "docs"
            all_rows = table.search().limit(100000).to_list()
            all_doc_ids = set()
            for row in all_rows:
                did = str(row.get("doc_id", ""))
                if did:
                    all_doc_ids.add(did)
            dead = [d for d in all_doc_ids if not (docs_dir / d / "full.md").exists()]

            for did in dead:
                table.delete(f"doc_id = '{did}'")
                total_removed += 1
                details.append(f"KB {kid}: removed orphan chunks for doc {did}")
        except Exception as e:
            details.append(f"KB {kid}: error - {e}")

    db.close()
    return {"status": "ok", "removed": total_removed, "details": details}
