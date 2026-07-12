"""Document indexing and deletion endpoints."""
from pathlib import Path
import base64
import re
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException, Response
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
    seamlessly across parts.

    Uses PdfReader for accurate PDF page counts (matching the split boundary),
    and MinerU boundary analysis to detect when a book page was cut in half
    at the split point.
    """
    m = re.search(r"_part(\d+)\.", doc_name)
    if not m:
        return 0
    part_num = int(m.group(1))
    if part_num <= 1:
        return 0

    parent_dir = doc_dir.parent
    base_name = doc_name[:m.start()]  # e.g. "高等代数讲义"

    # Load boundary overlap analysis (cached to disk — runs MinerU once per split doc)
    boundaries = _load_boundary_data(parent_dir, base_name)

    offset = 0
    for prev_part in range(1, part_num):
        pdf_pages = _get_part_pdf_pages(parent_dir, base_name, prev_part)
        # Check if this boundary cuts a book page in half
        boundary_key = f"part{prev_part}_to_part{prev_part+1}"
        if boundaries.get(boundary_key):
            pdf_pages -= 1  # overlapping page: book page continues in next part
        offset += pdf_pages

    print(f"[index] Computed page offset {offset} for {doc_name}", flush=True)
    return offset


def _get_part_pdf_pages(parent_dir: Path, base_name: str, part_num: int) -> int:
    """Read the actual PDF page count of a split part. Always accurate."""
    # Look for the part's PDF file in sibling directories
    for sibling in parent_dir.iterdir():
        if not sibling.is_dir():
            continue
        for f in sibling.iterdir():
            if f.name.startswith(base_name) and f"_part{part_num}." in f.name and f.suffix == ".pdf":
                try:
                    from PyPDF2 import PdfReader
                    reader = PdfReader(str(f))
                    return len(reader.pages)
                except Exception:
                    pass
                break
    # Fallback: try to estimate from page_map.cache or mineru_result.json
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
            if name.startswith(base_name) and f"_part{part_num}." in name:
                mr_path = sibling / "mineru_result.json"
                if mr_path.exists():
                    mr = json.loads(mr_path.read_text(encoding="utf-8"))
                    pdf_info = mr.get("pdf_info", [])
                    if pdf_info:
                        return len(pdf_info)
                page_cache = sibling / "page_map.cache"
                if page_cache.exists():
                    cache = json.loads(page_cache.read_text(encoding="utf-8"))
                    pages = cache.get("pages", [])
                    if pages:
                        return max(p.get("page_idx", 0) for p in pages) + 1
        except Exception:
            continue
    return 0


def _load_boundary_data(parent_dir: Path, base_name: str) -> dict:
    """Load or compute boundary overlap analysis for all split boundaries.

    Returns dict like {'part1_to_part2': True, 'part2_to_part3': False}
    where True means MinerU detected the boundary page was cut in half."""
    cache_path = parent_dir / "boundary_analysis.json"
    if cache_path.exists():
        try:
            import json
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    # Discover all parts
    parts = _discover_parts(parent_dir, base_name)
    if len(parts) < 2:
        return {}

    # Find the original unsplit PDF (parent document)
    original_pdf = None
    for f in parent_dir.iterdir():
        if f.suffix.lower() == ".pdf" and f.name.startswith(base_name) and "_part" not in f.name:
            original_pdf = f
            break
    if not original_pdf:
        return {}

    boundaries = {}
    for i in range(len(parts) - 1):
        p1_num, p1_dir = parts[i]
        p2_num, p2_dir = parts[i + 1]
        boundary_key = f"part{p1_num}_to_part{p2_num}"

        # Compute the boundary page index in the original PDF
        # Sum pages of all parts before the boundary
        boundary_page = 0
        for p in range(1, p1_num + 1):
            boundary_page += _get_part_pdf_pages(parent_dir, base_name, p)

        # Extract 2-page micro-PDF: last page of part N + first page of part N+1
        boundary_pdf = parent_dir / f"_boundary_{p1_num}_{p2_num}.pdf"
        try:
            _extract_pdf_pages(original_pdf, boundary_pdf, boundary_page - 1, 2)

            # Submit to MinerU for page detection
            try:
                from ..config import get_config
                config = get_config()
                if config.mineru_token:
                    from ..mineru_client import parse_document
                    result = parse_document(str(boundary_pdf), config.mineru_token)
                    import json as _json
                    cl = _json.loads(result.content_list_json)
                    mineru_pages = len(set(b.get("page_idx", 0) for b in cl))
                    # If MinerU detected < 2 pages, the two PDF pages
                    # were merged → they're the same book page
                    boundaries[boundary_key] = (mineru_pages < 2)
                    print(f"[boundary] {boundary_key}: pdf=2 mineru={mineru_pages} overlap={mineru_pages < 2}")
                else:
                    print(f"[boundary] No MinerU token, skipping boundary analysis")
            except Exception as e:
                print(f"[boundary] MinerU analysis failed for {boundary_key}: {e}")
        except Exception as e:
            print(f"[boundary] Failed to extract boundary PDF: {e}")
        finally:
            try:
                boundary_pdf.unlink()
            except Exception:
                pass

    # Cache results
    try:
        import json
        cache_path.write_text(json.dumps(boundaries), encoding="utf-8")
    except Exception:
        pass

    return boundaries


def _discover_parts(parent_dir: Path, base_name: str) -> list[tuple[int, Path]]:
    """Find all split-part directories for a document, sorted by part number."""
    parts = []
    for d in parent_dir.iterdir():
        if not d.is_dir():
            continue
        meta_path = d / "metadata.json"
        if not meta_path.exists():
            continue
        try:
            import json
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            name = meta.get("name", "")
            if name.startswith(base_name):
                pm = re.search(r"_part(\d+)\.", name)
                if pm:
                    parts.append((int(pm.group(1)), d))
        except Exception:
            continue
    parts.sort(key=lambda x: x[0])
    return parts


def _extract_pdf_pages(src: Path, dst: Path, start_page: int, count: int):
    """Extract *count* pages from *src* PDF starting at 0-based *start_page*."""
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(str(src))
    writer = PdfWriter()
    end = min(start_page + count, len(reader.pages))
    for i in range(start_page, end):
        writer.add_page(reader.pages[i])
    with open(dst, "wb") as f:
        writer.write(f)
    # Close reader to release file handles
    try:
        if hasattr(reader, "stream") and reader.stream:
            reader.stream.close()
    except Exception:
        pass


_PAGE_MARKER_RE = re.compile(r"\[PAGE:(\d+)(?:\|(-?\d+))?\]")


def _find_math_ranges(text: str) -> list[tuple[int, int]]:
    """Find ranges of LaTeX math blocks ($$...$$ and $...$) in *text*.
    Returns sorted list of (start, end) character positions.
    These ranges should be avoided when injecting page markers.
    """
    ranges: list[tuple[int, int]] = []
    # Display math: $$...$$
    for m in re.finditer(r"\$\$[\s\S]*?\$\$", text):
        ranges.append((m.start(), m.end()))
    # Inline math: $...$ (but not $$)
    for m in re.finditer(r"(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)", text):
        ranges.append((m.start(), m.end()))
    ranges.sort()
    # Merge overlapping/adjacent ranges
    merged: list[tuple[int, int]] = []
    for r in ranges:
        if merged and r[0] <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], r[1]))
        else:
            merged.append(r)
    return merged


def _math_end_at(pos: int, math_ranges: list[tuple[int, int]]) -> int:
    """If *pos* is inside a math range, return the end of that range.
    Otherwise return *pos* unchanged.
    """
    for start, end in math_ranges:
        if start <= pos < end:
            return end
    return pos


def _inject_page_markers(_markdown_text: str, doc_dir: Path) -> str:
    """Insert ``[PAGE:N|POS]`` markers into the **original markdown**.

    Previous implementation rebuilt text from content_list blocks, which
    lost ``$$...$$`` delimiters on display math and caused the chunker to
    split LaTeX formulas.  This version walks the original markdown, using
    content_list only to map block positions to page numbers.

    Returns the annotated markdown with all original content — including
    math delimiters — preserved verbatim.
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

    # ── Step 1: group blocks by page_idx, preserving content_list order ──
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

    # ── Step 2: locate each block in the original markdown ──
    # Forward-search preserves document order so that later blocks are
    # always found *after* earlier ones.
    _math_ranges = _find_math_ranges(_markdown_text)
    _entries: list[tuple[int, int]] = []      # (position_in_md, page_1based)
    _md_cursor = 0
    _matched = 0
    _total = sum(len(v) for v in page_blocks.values())

    for pi in range(min_pi, max_pi + 1):
        for text in page_blocks.get(pi, []):
            pos = _markdown_text.find(text, _md_cursor)
            if pos < 0:
                # Retry with shorter prefix (whitespace may differ)
                short = text[:max(20, len(text) // 3)]
                pos = _markdown_text.find(short, _md_cursor)
            if pos < 0:
                # Last resort: search from beginning
                pos = _markdown_text.find(text, 0)
            if pos >= 0:
                _md_cursor = pos + len(text)
                _entries.append((pos, pi + 1))
                _matched += 1

    print(f"[index] Matched {_matched}/{_total} content_list blocks in markdown",
          flush=True)

    # ── Step 3: sort by position & remove duplicates ──
    _entries.sort(key=lambda e: e[0])
    seen: set[int] = set()
    _entries = [(p, pg) for p, pg in _entries if not (p in seen or seen.add(p))]

    # ── Step 4: build tagged text by inserting markers into original md ──
    parts: list[str] = []
    cursor = 0

    for pos, page in _entries:
        # If position is inside a math block, defer marker to after $$ close
        safe = _math_end_at(pos, _math_ranges)
        parts.append(_markdown_text[cursor:safe])
        parts.append(f"[PAGE:{page}|{pos}]")
        cursor = safe

    # Remaining text after the last matched block
    parts.append(_markdown_text[cursor:])

    # ── Step 5: blank-page markers (pages with no matched blocks) ──
    # Place them right before the *next* content marker so they ride in
    # the same chunk and the page number is reachable.
    matched_pages = {pg for _, pg in _entries}
    blank_pages = [
        pi + 1 for pi in range(min_pi, max_pi + 1)
        if (pi + 1) not in matched_pages
    ]
    if blank_pages:
        # Group consecutive blanks and attach each to the nearest following
        # content position (or append at the very end).
        result = "".join(parts)
        for bp in blank_pages:
            # Find the first [PAGE:N|...] marker whose page > bp
            insert_before = None
            for m in _PAGE_MARKER_RE.finditer(result):
                if int(m.group(1)) > bp:
                    insert_before = m.start()
                    break
            marker = f"[PAGE:{bp}|-1]"
            if insert_before is not None:
                result = result[:insert_before] + marker + "\n\n" + result[insert_before:]
            else:
                result += "\n\n" + marker
        print(f"[index] Inserted {len(blank_pages)} blank-page markers", flush=True)
        return result

    return "".join(parts)


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

# Weight ranges for each stage (monotonically increasing).
# VLM is now a post-processing phase that runs AFTER the main pipeline
# completes, so it no longer has its own weight slot here.
_STAGE_WEIGHTS = {
    "chunking": (0, 5),
    "embedding": (5, 95),
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


def _mark_done(task_id: str, chunk_count: int = 0, embedding_model: str = "", embedding_dim: int = 0,
               vlm_pending: int = 0):
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
            "vlm_pending": vlm_pending,
            "vlm_total": vlm_pending,
            "vlm_status": "pending" if vlm_pending > 0 else "done",
            "vlm_current": 0,
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


def _update_vlm_progress(task_id: str, vlm_current: int, vlm_total: int, vlm_status: str = "processing", **extra):
    """Update VLM progress for a task that has already been marked done.
    Does NOT regress the main percent (stays at 100)."""
    with _index_tasks_lock:
        prev = _index_tasks.get(task_id)
        if prev is None:
            return
        _index_tasks[task_id] = {
            **prev,
            "vlm_status": vlm_status,
            "vlm_current": vlm_current,
            "vlm_total": vlm_total,
            "vlm_pending": max(0, vlm_total - vlm_current),
            **extra,
        }


def _run_vlm_phase(task_id: str, vlm_info: dict):
    """Background VLM processing — runs AFTER the main indexing pipeline is done.
    Uses a single shared httpx.Client connection pool across all concurrent threads
    to avoid exhausting system socket resources."""
    import time as _time
    doc_dir = Path(vlm_info["doc_dir"])
    mm_items = vlm_info["mm_items"]
    image_descriptions = vlm_info["image_descriptions"]
    image_count = vlm_info["image_count"]
    vlm_api_base = vlm_info["vlm_api_base"]
    vlm_api_key = vlm_info["vlm_api_key"]
    vlm_model = vlm_info["vlm_model"]
    vlm_concurrency = vlm_info["vlm_concurrency"]

    try:
        from ..vision import describe_image
        import httpx
        from concurrent.futures import ThreadPoolExecutor, as_completed

        img_dir = doc_dir / "images"
        cached_meta = _load_image_meta(doc_dir)
        vlm_done = image_count - vlm_info.get("pending_count", 0)
        new_meta_entries: dict[str, tuple[str, dict]] = {}

        # Identify pending images
        pending: list[dict] = []
        for mi in mm_items:
            if mi["type"] != "image":
                continue
            img_name = mi.get("img_path", "").split("/")[-1]
            if not img_name or not (img_dir / img_name).exists():
                continue
            if not _is_valid_description(image_descriptions.get(img_name, ("",))[0]):
                pending.append(mi)

        if not pending:
            _update_vlm_progress(task_id, image_count, image_count, "done")
            return

        _update_vlm_progress(task_id, vlm_done, image_count, "processing")

        MAX_VLM_RETRIES = 3
        VLM_REQUEST_TIMEOUT = 30.0
        VLM_TOTAL_TIMEOUT = 120.0  # per-image cap including retries

        # Create ONE shared httpx client with a bounded connection pool.
        # All concurrent _describe_one calls share this pool, preventing
        # socket resource exhaustion when multiple documents/images are
        # processed in parallel.
        with httpx.Client(
            timeout=VLM_REQUEST_TIMEOUT,
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        ) as http_client:

            def _describe_one(mi: dict) -> tuple[str, str, dict, str]:
                img_name = mi.get("img_path", "").split("/")[-1]
                img_file = img_dir / img_name
                fmt = img_file.suffix.lstrip(".") or "png"
                caption = mi.get("text", "")
                last_error = ""
                deadline = _time.monotonic() + VLM_TOTAL_TIMEOUT
                for attempt in range(MAX_VLM_RETRIES):
                    if _time.monotonic() > deadline:
                        if not last_error:
                            last_error = f"total timeout ({VLM_TOTAL_TIMEOUT}s)"
                        break
                    try:
                        desc, entity = describe_image(
                            img_file.read_bytes(), fmt,
                            vlm_api_base=vlm_api_base, vlm_api_key=vlm_api_key,
                            vlm_model=vlm_model, caption=caption, http=http_client,
                        )
                        if _is_valid_description(desc):
                            return img_name, desc, entity, ""
                        last_error = f"empty/invalid description (attempt {attempt+1})"
                    except Exception as e:
                        last_error = str(e)
                    if attempt < MAX_VLM_RETRIES - 1:
                        _time.sleep(1.0 * (attempt + 1))
                return img_name, caption or "Image", {"entity_name": img_name, "entity_type": "image", "summary": caption}, last_error

            vlm_lock = threading.Lock()
            workers = min(max(1, vlm_concurrency), len(pending))
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {executor.submit(_describe_one, mi): mi for mi in pending}
                for future in as_completed(futures):
                    mi = futures[future]
                    img_name, desc, entity, err = future.result()
                    if err:
                        import sys
                        print(f"[index] VLM background failed for {img_name}: {err}", file=sys.stderr)
                    image_descriptions[img_name] = (desc, entity)
                    new_meta_entries[img_name] = (desc, entity)
                    with vlm_lock:
                        vlm_done += 1
                        _update_vlm_progress(task_id, vlm_done, image_count, "processing")
                    # Yield GIL briefly so uvicorn's asyncio loop can process
                    # pending HTTP requests instead of being starved by VLM threads
                    _time.sleep(0)

        # Write descriptions
        if new_meta_entries:
            _save_image_meta_batch(doc_dir, new_meta_entries)

        # Retry: second pass for any still-missing descriptions
        missed = []
        for img_name, (desc, _) in image_descriptions.items():
            if not _is_valid_description(desc):
                missed.append(img_name)
        if missed:
            import sys
            print(f"[index] VLM background retrying {len(missed)} images...", file=sys.stderr)
            retry_items = [mi for mi in pending if mi.get("img_path", "").split("/")[-1] in missed]
            if retry_items:
                with httpx.Client(
                    timeout=VLM_REQUEST_TIMEOUT,
                    limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
                ) as retry_http:
                    def _retry_one(mi: dict) -> tuple[str, str, dict, str]:
                        img_name = mi.get("img_path", "").split("/")[-1] or f"image_{mi.get('page_idx','')}"
                        img_file = img_dir / img_name
                        fmt = img_file.suffix.lstrip(".") or "png"
                        caption = mi.get("text", "")
                        last_error = ""
                        deadline = _time.monotonic() + VLM_TOTAL_TIMEOUT
                        for attempt in range(MAX_VLM_RETRIES):
                            if _time.monotonic() > deadline:
                                break
                            try:
                                desc, entity = describe_image(
                                    img_file.read_bytes(), fmt,
                                    vlm_api_base=vlm_api_base, vlm_api_key=vlm_api_key,
                                    vlm_model=vlm_model, caption=caption, http=retry_http,
                                )
                                if _is_valid_description(desc):
                                    return img_name, desc, entity, ""
                                last_error = f"empty/invalid description (attempt {attempt+1})"
                            except Exception as e:
                                last_error = str(e)
                            if attempt < MAX_VLM_RETRIES - 1:
                                _time.sleep(1.0 * (attempt + 1))
                        return img_name, "", {"entity_name": img_name, "entity_type": "image", "summary": ""}, last_error

                    retry_meta: dict[str, tuple[str, dict]] = {}
                    retry_workers = min(max(1, vlm_concurrency), len(retry_items))
                    with ThreadPoolExecutor(max_workers=retry_workers) as retry_ex:
                        retry_futures = {retry_ex.submit(_retry_one, mi): mi for mi in retry_items}
                        for future in as_completed(retry_futures):
                            mi = retry_futures[future]
                            img_name, desc, entity, err = future.result()
                            if err:
                                print(f"[index] VLM background retry failed for {img_name}: {err}", file=sys.stderr)
                            if _is_valid_description(desc):
                                image_descriptions[img_name] = (desc, entity)
                                retry_meta[img_name] = (desc, entity)
                            _time.sleep(0)  # yield GIL
                    if retry_meta:
                        _save_image_meta_batch(doc_dir, retry_meta)

        still_missed = sum(1 for d in image_descriptions.values() if not _is_valid_description(d[0]))
        if still_missed > 0:
            _update_vlm_progress(task_id, image_count, image_count, "done",
                                 vlm_error=f"{still_missed} images without valid description")
        else:
            _update_vlm_progress(task_id, image_count, image_count, "done")

    except Exception as e:
        import sys, traceback
        print(f"[index] VLM background phase failed for {task_id}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        _update_vlm_progress(task_id, 0, image_count, "error", vlm_error=str(e))


def _prepare_tagged_markdown(markdown_content: str, doc_dir: Path, doc_name: str) -> tuple[str, int]:
    """Prepare markdown with page markers and split-document offset adjustment.

    This is a standalone step that:
    1. Computes the split-document page offset (for multi-part PDFs)
    2. Injects [PAGE:N|POS] markers into the markdown
    3. Adjusts marker page numbers for split parts

    Returns (tagged_markdown, split_offset).
    """
    split_offset = _compute_page_offset(doc_dir, doc_name)
    tagged_md = _inject_page_markers(markdown_content, doc_dir)
    if split_offset > 0:
        tagged_md = _PAGE_MARKER_RE.sub(
            lambda m: (
                f"[PAGE:{int(m.group(1)) + split_offset}|{m.group(2)}]"
                if m.group(2) is not None
                else f"[PAGE:{int(m.group(1)) + split_offset}]"
            ),
            tagged_md,
        )
    return tagged_md, split_offset


def _read_user_page_offset(doc_dir: Path) -> int:
    """Read user-set page_offset from metadata.json (real-page adjustment)."""
    meta_path = doc_dir / "metadata.json"
    if not meta_path.exists():
        return 0
    try:
        import json as _json
        doc_meta = _json.loads(meta_path.read_text(encoding="utf-8"))
        return doc_meta.get("page_offset", 0)
    except Exception:
        return 0


def _apply_page_offsets_to_mm_chunks(mm_chunks: list, split_offset: int, user_page_offset: int):
    """Apply split and user page offsets to multimodal chunks.

    Multimodal chunks use raw page_idx (0-based); converts to 1-based virtual pages,
    adds split_offset, then applies user_page_offset so numbering is consistent
    with text chunks.
    """
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

        # ── Step 1: Prepare markdown with page markers + split offset ──
        tagged_md, split_offset = _prepare_tagged_markdown(req.markdown_content, doc_dir, req.doc_name)

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

        # Merge adjacent small chunks produced by PAGE-marker splitting
        from ..chunker import RecursiveChunker
        before = len(chunks)
        chunks = RecursiveChunker._merge_small_chunks(chunks)
        after = len(chunks)

        # ── Step 2: Read user page offset ──
        user_page_offset = _read_user_page_offset(doc_dir)

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

        # ── Multimodal chunks (non-blocking — VLM runs in background after indexing) ──
        mm_chunks = []
        vlm_pending_count = 0
        _vlm_info: dict = {}
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

                # Load cached descriptions only (non-blocking — no VLM API calls during indexing)
                if has_vlm and image_count > 0:
                    img_dir = doc_dir / "images"
                    cached_meta = _load_image_meta(doc_dir)
                    cached_count = 0
                    for mi in mm_items:
                        if mi["type"] != "image":
                            continue
                        img_name = mi.get("img_path", "").split("/")[-1]
                        if not img_name or not (img_dir / img_name).exists():
                            continue
                        if _is_valid_description(cached_meta.get(img_name, {}).get("description", "")):
                            cached = cached_meta[img_name]
                            image_descriptions[img_name] = (cached["description"], cached.get("entity_info", {}))
                            cached_count += 1

                    vlm_pending_count = image_count - cached_count
                    if cached_count > 0:
                        import sys
                        print(f"[index] Reused {cached_count} cached VLM descriptions", file=sys.stderr)

                    if vlm_pending_count > 0:
                        _vlm_info = {
                            "doc_dir": str(doc_dir),
                            "mm_items": mm_items,
                            "image_descriptions": dict(image_descriptions),
                            "image_count": image_count,
                            "pending_count": vlm_pending_count,
                            "vlm_api_base": config.vlm_api_base,
                            "vlm_api_key": config.vlm_api_key,
                            "vlm_model": config.vlm_model,
                            "vlm_concurrency": config.vlm_concurrency,
                        }

                mm_chunks = multimodal_chunks_from_content_list(
                    mm_items,
                    metadata={"doc_id": req.doc_id, "doc_name": req.doc_name},
                    image_descriptions=image_descriptions if image_descriptions else None,
                )
            except Exception as e:
                import sys
                print(f"[index] multimodal generation failed: {e}", file=sys.stderr)

        all_chunks = chunks + mm_chunks

        # ── Step 3: Apply page offsets to multimodal chunks ──
        _apply_page_offsets_to_mm_chunks(mm_chunks, split_offset, user_page_offset)

        if not all_chunks:
            _mark_done(task_id, 0, config.embedding_model, embedding_dim, vlm_pending_count)
            # Start VLM background phase if needed (even with 0 chunks, we still want descriptions)
            if _vlm_info:
                _vlm_info["pending_count"] = vlm_pending_count
                threading.Thread(target=_run_vlm_phase, args=(task_id, _vlm_info), daemon=True).start()
            return

        # ── Embedding with progress ──
        texts = [c.content for c in all_chunks]
        total = len(texts)
        batch_size = 50
        all_vectors = []

        try:
            for i in range(0, total, batch_size):
                batch = texts[i:i + batch_size]
                batch_vecs = embedder.embed(batch)
                all_vectors.extend(batch_vecs)
                embedded = min(i + batch_size, total)
                _set_progress(task_id, "embedding", embedded, total)
        finally:
            embedder.close()

        # ── Store ──
        _set_progress(task_id, "storing", 0, 0)
        try:
            count = db.insert_chunks(
                kb_id=req.kb_id,
                chunks=all_chunks,
                vectors=all_vectors,
                doc_id=req.doc_id,
                doc_name=req.doc_name or req.doc_id,
                chunk_strategy=strategy,
            )
        finally:
            db.close()

        _mark_done(task_id, count, config.embedding_model, embedding_dim, vlm_pending_count)

        # ── Start VLM background phase if there are pending images ──
        if _vlm_info:
            _vlm_info["pending_count"] = vlm_pending_count
            threading.Thread(target=_run_vlm_phase, args=(task_id, _vlm_info), daemon=True).start()

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


@router.delete("/index/task/{task_id}")
def cancel_index_task(task_id: str):
    """Cancel a running indexing task. Marks it as failed with a cancellation message."""
    with _index_tasks_lock:
        task = _index_tasks.get(task_id)
    if task is None:
        raise HTTPException(404, f"Task not found: {task_id}")
    if task.get("done"):
        return {"status": "already_completed", "message": "Task was already done"}
    _mark_failed(task_id, "Cancelled by user")
    return {"status": "cancelled", "task_id": task_id}


@router.get("/index/vlm-status/{task_id}")
def index_vlm_status(task_id: str):
    """Get VLM post-processing status for a completed indexing task."""
    with _index_tasks_lock:
        task = _index_tasks.get(task_id)
    if task is None:
        raise HTTPException(404, f"Task not found: {task_id}")
    return {
        "vlm_status": task.get("vlm_status", "done"),
        "vlm_current": task.get("vlm_current", 0),
        "vlm_total": task.get("vlm_total", 0),
        "vlm_pending": task.get("vlm_pending", 0),
        "vlm_error": task.get("vlm_error", ""),
        "chunk_count": task.get("chunk_count", 0),
    }


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


@router.get("/images/serve/{filename:path}")
def serve_document_image_search(filename: str, kb_id: str = "", doc_id: str = ""):
    """Serve a document image. If kb_id and doc_id are provided, look there.
    Otherwise search all KBs/docs for the image file."""
    config = get_config()
    data_dir = Path(config.knowledge_base_data_dir)

    if kb_id and doc_id:
        # Direct path
        candidates = [data_dir / f"kb_{kb_id}" / "docs" / doc_id / "images" / filename]
    else:
        # Search all KBs/docs
        candidates = []
        for kb_dir in data_dir.glob("kb_*/docs/*/images/*"):
            if kb_dir.name == filename:
                candidates.append(kb_dir)

    for img_path in candidates:
        if img_path and img_path.exists():
            fmt = img_path.suffix.lstrip(".") or "png"
            return Response(img_path.read_bytes(), media_type=f"image/{fmt}")

    raise HTTPException(404, f"Image not found: {filename}")


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
