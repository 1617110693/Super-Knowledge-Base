"""Document indexing and deletion endpoints."""
from pathlib import Path
import base64
import re
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


def _compute_page_offset(doc_dir: Path, doc_name: str) -> int:
    """If this is a split-part document (e.g., _part2.pdf), compute the
    cumulative page count from all previous parts so page numbers continue
    seamlessly across parts."""
    m = re.search(r"_part(\d+)\.", doc_name)
    if not m:
        return 0
    part_num = int(m.group(1))
    if part_num <= 1:
        return 0

    parent_dir = doc_dir.parent
    base_name = doc_name[:m.start()]  # e.g. "高等代数讲义"

    offset = 0
    for prev_part in range(1, part_num):
        # Find sibling part directory — look for dirs with matching base name and _partN
        for sibling in parent_dir.iterdir():
            if not sibling.is_dir():
                continue
            meta_path = sibling / "metadata.json"
            if not meta_path.exists():
                continue
            try:
                import json
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                name = meta.get("name", "")
                if name.startswith(base_name) and f"_part{prev_part}." in name:
                    # Found previous part — read its page count
                    page_cache = sibling / "page_map.cache"
                    if page_cache.exists():
                        cache = json.loads(page_cache.read_text(encoding="utf-8"))
                        pages = cache.get("pages", [])
                        if pages:
                            # Max page_idx + 1 = total pages in this part
                            max_idx = max(p.get("page_idx", 0) for p in pages)
                            offset += max_idx + 1
                            break
                    # Fallback: check mineru_result.json
                    mr_path = sibling / "mineru_result.json"
                    if mr_path.exists():
                        mr = json.loads(mr_path.read_text(encoding="utf-8"))
                        pdf_info = mr.get("pdf_info", [])
                        if pdf_info:
                            offset += len(pdf_info)
                            break
            except Exception:
                continue
        else:
            # Couldn't find previous part — estimate from PDF
            for sibling in parent_dir.iterdir():
                if not sibling.is_dir():
                    continue
                for f in sibling.iterdir():
                    if f.name.startswith(base_name) and f"_part{prev_part}" in f.name and f.suffix == ".pdf":
                        try:
                            from PyPDF2 import PdfReader
                            reader = PdfReader(str(f))
                            offset += len(reader.pages)
                        except Exception:
                            pass
                        break

    print(f"[index] Computed page offset {offset} for {doc_name}", flush=True)
    return offset


_PAGE_MARKER_RE = re.compile(r"\[PAGE:(\d+)(?:\|(-?\d+))?\]")


def _inject_page_markers(_markdown_text: str, doc_dir: Path) -> str:
    """Build tagged text from content_list.json blocks.

    Every text-carrying block gets a ``[PAGE:N]`` prefix so its page
    identity survives chunking.  Uses content_list order directly —
    NO substring matching against the markdown (which has a different
    block order than content_list).  Aligns with how RAGFlow's
    ``separate_content`` works.

    Returns the tagged plain text.  The original markdown is NOT used
    because its block order differs from content_list.
    """
    cl_path = doc_dir / "content_list.json"
    if not cl_path.exists():
        return _markdown_text

    try:
        import json as _json
        cl_data = _json.loads(cl_path.read_text(encoding="utf-8"))
    except Exception:
        return _markdown_text

    from ..page_mapper import _extract_content_list_text

    # Group blocks by page_idx, preserving content_list order
    page_blocks: dict[int, list[str]] = {}
    min_pi: int | None = None
    max_pi: int | None = None
    for item in cl_data:
        if not isinstance(item, dict):
            continue
        pi = item.get("page_idx")
        if not isinstance(pi, int):
            continue
        if min_pi is None or pi < min_pi:
            min_pi = pi
        if max_pi is None or pi > max_pi:
            max_pi = pi
        text = _extract_content_list_text(item)
        if text:
            page_blocks.setdefault(pi, []).append(text)

    if min_pi is None:
        return _markdown_text

    # Build tagged text: for every page in the full range [min_pi, max_pi],
    # emit its blocks.  Pages with no blocks in content_list get a
    # placeholder [PAGE:N] so every page is reachable.
    # Also embed each block's character position in the ORIGINAL markdown
    # so start_char can be recovered after chunking without fragile
    # substring search.
    parts: list[str] = []
    inserted = 0
    blank_pages = 0
    _md_search = 0
    for pi in range(min_pi, max_pi + 1):
        blocks = page_blocks.get(pi, [])
        if blocks:
            for text in blocks:
                pos = _markdown_text.find(text, _md_search)
                if pos < 0:
                    pos = _markdown_text.find(text[:max(15, len(text)//3)], _md_search)
                if pos < 0:
                    pos = _markdown_text.find(text, 0)
                if pos >= 0:
                    _md_search = pos + len(text)
                parts.append(f"[PAGE:{pi + 1}|{pos}]{text}")
                inserted += 1
        else:
            parts.append(f"[PAGE:{pi + 1}|-1]")
            inserted += 1
            blank_pages += 1

    total_pages = max_pi - min_pi + 1
    print(f"[index] Built tagged text with {inserted} PAGE markers "
          f"({total_pages} pages, {len(page_blocks)} with content, {blank_pages} blank)", flush=True)
    return "\n\n".join(parts)


def _extract_page_range(chunk_text: str) -> tuple[int, int, int]:
    """Return (page_start, page_end, start_char, clean_text).

    Markers use format [PAGE:N|POS] where POS is the character offset
    in the original markdown (-1 if unknown).
    """
    pages = []
    start_char = -1
    for m in _PAGE_MARKER_RE.finditer(chunk_text):
        pages.append(int(m.group(1)))
        if m.group(2) is not None and start_char < 0:
            start_char = int(m.group(2))
    clean = _PAGE_MARKER_RE.sub("", chunk_text)
    if pages:
        return min(pages), max(pages), start_char if start_char >= 0 else None, clean
    return 0, 0, None, clean


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

        # Compute split-document offset BEFORE injecting markers
        split_offset = _compute_page_offset(doc_dir, req.doc_name)

        # Inject [PAGE:N] markers into markdown so chunks carry page info
        tagged_md = _inject_page_markers(req.markdown_content, doc_dir)
        if split_offset > 0:
            tagged_md = _PAGE_MARKER_RE.sub(
                lambda m: (
                    f"[PAGE:{int(m.group(1)) + split_offset}|{m.group(2)}]"
                    if m.group(2) is not None
                    else f"[PAGE:{int(m.group(1)) + split_offset}]"
                ),
                tagged_md,
            )

        chunker = Chunker.create(strategy, chunk_size, chunk_overlap)
        chunks = chunker.chunk(
            tagged_md,
            metadata={"doc_id": req.doc_id, "doc_name": req.doc_name},
            page_mapper=None,
        )

        # Split chunks that span multiple pages at PAGE marker boundaries
        # Split chunks that span multiple pages at PAGE marker boundaries.
        # Assign page from the marker directly — sub-chunks don't contain
        # the markers, so _extract_page_range would return (0,0).
        import copy as _copy_mod2
        _split_chunks = []
        for c in chunks:
            markers = list(re.finditer(r"\[PAGE:(\d+)(?:\|(-?\d+))?\]", c.content))
            pages_seen = {int(m.group(1)) for m in markers}
            if len(pages_seen) <= 1:
                _split_chunks.append(c)
            else:
                leading = c.content[:markers[0].start()].strip()
                first_page = int(markers[0].group(1))
                for i, m in enumerate(markers):
                    start = m.end()
                    end = markers[i + 1].start() if i + 1 < len(markers) else len(c.content)
                    sub = c.content[start:end].strip()
                    if i == 0 and leading:
                        sub = leading + "\n" + sub if sub else leading
                    if sub:
                        nc = _copy_mod2.deepcopy(c)
                        nc.content = sub
                        page = int(m.group(1))
                        nc.metadata["page"] = page
                        nc.metadata["page_start"] = page
                        nc.metadata["page_end"] = page
                        if m.group(2) is not None:
                            nc.metadata["start_char"] = int(m.group(2))
                        _split_chunks.append(nc)
        chunks = _split_chunks if _split_chunks else chunks

        # Read user-set page_offset from metadata.json (real-page adjustment)
        meta_path = doc_dir / "metadata.json"
        user_page_offset = 0
        if meta_path.exists():
            try:
                import json as _json3
                doc_meta = _json3.loads(meta_path.read_text(encoding="utf-8"))
                user_page_offset = doc_meta.get("page_offset", 0)
            except Exception:
                pass

        # Only user page_offset here — split_offset is already baked
        # into the PAGE markers (applied during _inject_page_markers).

        # Extract page ranges from markers (for non-split chunks)
        last_page = 0
        for c in chunks:
            if "page_start" not in c.metadata:
                ps, pe, sc, clean = _extract_page_range(c.content)
                c.content = clean
                if ps == 0 and pe == 0:
                    ps = pe = last_page if last_page > 0 else 1
                c.metadata["page"] = ps
                c.metadata["page_start"] = ps
                c.metadata["page_end"] = pe
                if sc is not None:
                    c.metadata["start_char"] = sc
            else:
                # Already assigned by splitter — just strip markers
                c.content = _PAGE_MARKER_RE.sub("", c.content)
                ps = c.metadata["page_start"]
            # Track last_page BEFORE offset so continuation chunks
            # inherit the correct virtual page (not double-offset).
            if ps > 0:
                last_page = ps
            # Apply user-set page_offset (NOT split-offset — that's in markers)
            if user_page_offset:
                c.metadata["page"] = c.metadata["page"] - user_page_offset
                c.metadata["page_start"] = c.metadata["page_start"] - user_page_offset
                c.metadata["page_end"] = c.metadata["page_end"] - user_page_offset

        # Most chunks already have start_char from PAGE markers.
        # For any remaining chunks without start_char, try to map them
        # back to the original markdown using forward substring search.
        _search_from = 0
        for c in chunks:
            if "start_char" in c.metadata and isinstance(c.metadata.get("start_char"), int) and c.metadata["start_char"] >= 0:
                _search_from = max(_search_from, c.metadata["start_char"] + len(c.content))
            else:
                if c.content.strip():
                    lookback = max(0, _search_from - 256)
                    idx = req.markdown_content.find(c.content, lookback)
                    if idx < 0:
                        prefix = c.content[:80]
                        idx = req.markdown_content.find(prefix, lookback)
                    if idx < 0 and _search_from > 0:
                        idx = req.markdown_content.find(c.content, 0)
                        if idx < 0:
                            idx = req.markdown_content.find(c.content[:80], 0)
                    if idx >= 0:
                        c.metadata["start_char"] = idx
                        _search_from = idx + len(c.content)

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

                    # Process pending images concurrently (with retry)
                    if pending:
                        MAX_VLM_RETRIES = 3

                        def _describe_one(mi: dict, api_base: str, api_key: str, model: str) -> tuple[str, str, dict, str]:
                            img_name = mi.get("img_path", "").split("/")[-1]
                            img_file = img_dir / img_name
                            fmt = img_file.suffix.lstrip(".") or "png"
                            caption = mi.get("text", "")
                            last_error = ""
                            for attempt in range(MAX_VLM_RETRIES):
                                try:
                                    with httpx.Client(timeout=60.0) as client:
                                        desc, entity = describe_image(
                                            img_file.read_bytes(), fmt,
                                            vlm_api_base=api_base, vlm_api_key=api_key,
                                            vlm_model=model, caption=caption, http=client,
                                        )
                                    if _is_valid_description(desc):
                                        return img_name, desc, entity, ""
                                    last_error = f"empty/invalid description (attempt {attempt+1})"
                                except Exception as e:
                                    last_error = str(e)
                                if attempt < MAX_VLM_RETRIES - 1:
                                    import time as _time
                                    _time.sleep(1.0 * (attempt + 1))  # backoff
                            # All retries exhausted
                            return img_name, caption or "Image", {"entity_name": img_name, "entity_type": "image", "summary": caption}, last_error

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
                                img_name, desc, entity, err = future.result()
                                if err:
                                    import sys
                                    print(f"[index] VLM failed for {img_name}: {err}", file=sys.stderr)
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

                    # Second pass: retry any images that still have no valid description.
                    # Uses a separate executor (the first-pass executor has shut down).
                    # Does NOT increment vlm_done — image_count is fixed at first pass.
                    missed = []
                    for img_name, (desc, _) in image_descriptions.items():
                        if not _is_valid_description(desc):
                            missed.append(img_name)
                    if missed:
                        import sys
                        print(f"[index] Retrying {len(missed)} images that have no valid description...", file=sys.stderr)
                        retry_meta: dict[str, tuple[str, dict]] = {}
                        retry_items = [mi for mi in pending if mi.get("img_path", "").split("/")[-1] in missed]
                        if retry_items:
                            retry_workers = min(max(1, config.vlm_concurrency), len(retry_items))
                            retry_done = 0
                            with ThreadPoolExecutor(max_workers=retry_workers) as retry_ex:
                                retry_futures = {
                                    retry_ex.submit(
                                        _describe_one, mi,
                                        config.vlm_api_base, config.vlm_api_key, config.vlm_model,
                                    ): mi
                                    for mi in retry_items
                                }
                                for future in as_completed(retry_futures):
                                    mi = retry_futures[future]
                                    img_name = mi.get("img_path", "").split("/")[-1] or f"image_{mi.get('page_idx','')}"
                                    desc, entity, err = future.result()
                                    if err:
                                        print(f"[index] Retry VLM failed for {img_name}: {err}", file=sys.stderr)
                                    if _is_valid_description(desc):
                                        image_descriptions[img_name] = (desc, entity)
                                        retry_meta[img_name] = (desc, entity)
                                    retry_done += 1
                                    _set_progress(task_id, "vlm", image_count, image_count,
                                                  retry=f"{retry_done}/{len(retry_items)}")
                            if retry_meta:
                                _save_image_meta_batch(doc_dir, retry_meta)
                        still_missed = sum(
                            1 for d in image_descriptions.values()
                            if not _is_valid_description(d[0])
                        )
                        print(f"[index] After retry: {still_missed} images still without valid description", file=sys.stderr)

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

        # Multimodal chunks use raw page_idx (0-based); convert to 1-based
        # virtual pages, add split_offset, then apply user_page_offset so
        # numbering is consistent with text chunks.
        for c in mm_chunks:
            for key in ("page", "page_start", "page_end"):
                val = c.metadata.get(key, 0)
                if isinstance(val, int):
                    c.metadata[key] = val + 1 + split_offset
            if split_offset > 0:
                c.content = re.sub(
                    r"Page:\s*(\d+)",
                    lambda m: f"Page: {int(m.group(1)) + split_offset}",
                    c.content,
                )
        if user_page_offset:
            for c in mm_chunks:
                for key in ("page", "page_start", "page_end"):
                    val = c.metadata.get(key, 0)
                    if isinstance(val, int):
                        c.metadata[key] = val - user_page_offset

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


# ── Fill-missing progress tracking (same pattern as index tasks) ──

_fill_tasks: dict[str, dict] = {}
_fill_tasks_lock = threading.Lock()


@router.post("/images/fill-missing")
def fill_missing_images(req: DescribeImageRequest):
    """Start async task: scan document images and fill missing VLM descriptions.

    Returns a task_id immediately. Poll GET /images/fill-missing/progress/{task_id}
    for progress updates."""
    config = get_config()
    if not config.vlm_enabled or not config.vlm_api_base.strip() or not config.vlm_model.strip():
        raise HTTPException(400, "VLM not configured or disabled")

    doc_dir = Path(config.knowledge_base_data_dir) / f"kb_{req.kb_id}" / "docs" / req.doc_id
    img_dir = doc_dir / "images"
    if not img_dir.exists():
        raise HTTPException(404, "No images directory")

    meta = _load_image_meta(doc_dir)
    _IMG_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}

    # Only scan real document images (image/picture/chart types from content_list),
    # NOT formula renders (inline_math_*.png) or other generated images
    real_images: set[str] = set()
    cl_path = doc_dir / "content_list.json"
    if cl_path.exists():
        try:
            from ..page_mapper import extract_multimodal_items
            import json as _json2
            cl_data = _json2.loads(cl_path.read_text(encoding="utf-8"))
            for mi in extract_multimodal_items(cl_data):
                if mi.get("type") in ("image", "picture", "chart"):
                    img_name = mi.get("img_path", "").split("/")[-1]
                    if img_name:
                        real_images.add(img_name)
        except Exception:
            pass

    # Fallback: if no content_list, scan all images in directory
    if not real_images:
        for fname in sorted(img_dir.iterdir()):
            if fname.suffix.lower() in _IMG_EXTS:
                real_images.add(fname.name)

    missing: list[str] = []
    for fname in sorted(real_images):
        # Only check files that actually exist in the images dir
        if not (img_dir / fname).exists():
            continue
        desc = meta.get(fname, {}).get("description", "")
        if not _is_valid_description(desc):
            missing.append(fname)

    if not missing:
        return {"task_id": "", "message": "All images have valid descriptions", "done": True}

    task_id = str(uuid.uuid4())
    with _fill_tasks_lock:
        _fill_tasks[task_id] = {
            "stage": "starting",
            "current": 0,
            "total": len(missing),
            "done": False,
            "message": "",
        }

    def _run_fill():
        from ..vision import describe_image
        import httpx
        from concurrent.futures import ThreadPoolExecutor, as_completed

        vlm_concurrency = max(1, config.vlm_concurrency)
        new_meta: dict[str, tuple[str, dict]] = {}
        filled = 0
        failed = 0
        failed_details: list[dict] = []
        MAX_RETRIES = 3

        def _describe_one(fname: str) -> tuple[str, str, dict, str]:
            img_path = img_dir / fname
            img_bytes = img_path.read_bytes()
            fmt = fname.rsplit(".", 1)[-1]
            last_error = ""
            for attempt in range(MAX_RETRIES):
                try:
                    with httpx.Client(timeout=60.0) as http:
                        desc_text, entity = describe_image(
                            img_bytes, fmt,
                            vlm_api_base=config.vlm_api_base,
                            vlm_api_key=config.vlm_api_key,
                            vlm_model=config.vlm_model,
                            http=http,
                        )
                    if _is_valid_description(desc_text):
                        return fname, desc_text, entity, ""
                    last_error = f"empty/invalid description (attempt {attempt+1})"
                except Exception as e:
                    last_error = str(e)
                if attempt < MAX_RETRIES - 1:
                    import time as _t; _t.sleep(1.0 * (attempt + 1))
            return fname, "", {"entity_name": fname, "entity_type": "image", "summary": ""}, last_error

        workers = min(vlm_concurrency, len(missing))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(_describe_one, f): f for f in missing}
            for future in as_completed(futures):
                fname, desc, entity, err = future.result()
                if _is_valid_description(desc):
                    new_meta[fname] = (desc, entity)
                    filled += 1
                else:
                    failed += 1
                    failed_details.append({"name": fname, "error": err or "unknown"})
                with _fill_tasks_lock:
                    done = filled + failed
                    _fill_tasks[task_id] = {
                        "stage": "vlm",
                        "current": done,
                        "total": len(missing),
                        "done": False,
                        "current_name": fname,
                        "message": f"{done}/{len(missing)}",
                    }

        if new_meta:
            _save_image_meta_batch(doc_dir, new_meta)

        with _fill_tasks_lock:
            _fill_tasks[task_id] = {
                "stage": "done",
                "current": len(missing),
                "total": len(missing),
                "done": True,
                "filled": filled,
                "failed": failed,
                "failed_details": failed_details,
                "message": f"Filled {filled} of {len(missing)} missing descriptions ({failed} failed)",
            }

    threading.Thread(target=_run_fill, daemon=True).start()
    return {"task_id": task_id, "total": len(missing), "done": False}


@router.get("/images/fill-missing/progress/{task_id}")
def fill_missing_progress(task_id: str):
    """Get the progress of a fill-missing task started by POST /images/fill-missing."""
    with _fill_tasks_lock:
        task = _fill_tasks.get(task_id)
    if not task:
        raise HTTPException(404, f"Task not found: {task_id}")
    return task


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


# ═══════════════════════════════════════════════════════════════════
# Debug: page-jump preview endpoint
# ═══════════════════════════════════════════════════════════════════

@router.get("/debug/page-jump/{kb_id}/{doc_id}")
def debug_page_jump(kb_id: str, doc_id: str, page: int = 1):
    """Show what content a page jump would land on.

    Returns:
    - All chunks on the requested page (including multimodal)
    - Each chunk's start_char and a snippet of what's at that position
      in the original markdown
    - Nearest heading before the jump target
    - First/last 200 chars of the section the jump lands in
    """
    import json as _json
    import re as _re

    config = get_config()
    data_dir = Path(config.knowledge_base_data_dir)
    doc_dir = data_dir / f"kb_{kb_id}" / "docs" / doc_id

    # ── Read original markdown ──
    md_path = doc_dir / "full.md"
    if not md_path.exists():
        return {"error": "full.md not found", "kb_id": kb_id, "doc_id": doc_id}
    md = md_path.read_text(encoding="utf-8")

    # ── Query chunks for this page ──
    db = LanceDBManager(data_dir / "lancedb_data")
    try:
        table = db.get_table(kb_id)
        if table is None:
            return {"error": "KB table not found"}

        all_rows = table.search().where(f"doc_id = '{doc_id}'").limit(10000).to_list()
    finally:
        db.close()

    # Filter to chunks on the requested page
    page_chunks = []
    for r in all_rows:
        meta = {}
        try:
            meta = _json.loads(r.get("metadata_json", "{}"))
        except Exception:
            pass
        ps = meta.get("page_start", 0)
        pe = meta.get("page_end", 0)
        if ps <= page <= pe:
            page_chunks.append({
                "chunk_index": r.get("chunk_index"),
                "page_start": ps,
                "page_end": pe,
                "page": meta.get("page", 0),
                "start_char": meta.get("start_char"),
                "content_type": meta.get("content_type", "text"),
                "content": (r.get("content", "") or "")[:300],
            })

    page_chunks.sort(key=lambda c: c.get("chunk_index", 0) or 0)

    # ── For text chunks with start_char, show what's actually at that position ──
    verifications = []
    for c in page_chunks:
        sc = c.get("start_char")
        if sc is not None and 0 <= sc < len(md):
            ctx_before = md[max(0, sc - 40):sc]
            ctx_at = md[sc:sc + len(c["content"][:200])]
            ctx_after = md[sc + len(c["content"][:200]):sc + len(c["content"][:200]) + 40]
            match = c["content"][:60] in ctx_at
            verifications.append({
                "chunk_index": c["chunk_index"],
                "start_char": sc,
                "match": match,
                "before": ctx_before[-80:],
                "at_position": ctx_at[:200],
                "after": ctx_after[:40],
            })
        else:
            verifications.append({
                "chunk_index": c["chunk_index"],
                "start_char": sc,
                "match": None,
                "note": "start_char missing or out of range" if sc is None else f"out of range: {sc} >= {len(md)}",
            })

    # ── Find nearest heading before the jump target ──
    first_sc = None
    for c in page_chunks:
        sc = c.get("start_char")
        if sc is not None and sc >= 0:
            first_sc = sc
            break

    headings_before = []
    if first_sc is not None:
        for m in _re.finditer(r"^#{1,6}\s+(.+)$", md[:first_sc], _re.MULTILINE):
            headings_before.append({
                "text": m.group(1),
                "pos": m.start(),
                "level": len(m.group(0).split()[0]) if m.group(0).split() else 0,
            })

    # ── Section content around jump target ──
    section_context = ""
    if first_sc is not None:
        # Find the section boundaries around this position
        section_starts = [0] + [m.start() for m in _re.finditer(r"^#{1,3}\s+", md, _re.MULTILINE)]
        section_starts.sort()
        target_section_start = 0
        target_section_end = len(md)
        for i, ss in enumerate(section_starts):
            if ss <= first_sc:
                target_section_start = ss
                target_section_end = section_starts[i + 1] if i + 1 < len(section_starts) else len(md)
        section_context = md[target_section_start:target_section_end][:500]

    return {
        "kb_id": kb_id,
        "doc_id": doc_id,
        "page": page,
        "page_chunks_count": len(page_chunks),
        "text_chunks": len([c for c in page_chunks if c["content_type"] == "text"]),
        "mm_chunks": len([c for c in page_chunks if c["content_type"] != "text"]),
        "chunks": page_chunks,
        "verifications": verifications,
        "headings_before_target": headings_before[-5:] if headings_before else [],
        "section_context_first_500_chars": section_context[:500],
        "markdown_total_chars": len(md),
    }
