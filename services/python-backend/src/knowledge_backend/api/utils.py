"""Utility endpoints: PDF splitting, orphan cleanup, etc."""
import json
import os
import shutil
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel
from pypdf import PdfReader, PdfWriter

router = APIRouter()

MAX_PAGES = 200
MAX_SIZE_MB = 200


class SplitRequest(BaseModel):
    file_path: str
    max_pages: int = 200
    max_size_mb: int = 200


class SplitResult(BaseModel):
    original: str
    parts: list[str]
    split: bool


@router.post("/utils/split-pdf")
def split_pdf(req: SplitRequest) -> SplitResult:
    """Check a PDF and split it if exceeds limits.
    Returns list of file paths (original if no split needed)."""
    path = Path(req.file_path)
    if not path.exists():
        return SplitResult(original=req.file_path, parts=[req.file_path], split=False)

    file_size_mb = os.path.getsize(path) / (1024 * 1024)
    needs_split = False

    try:
        reader = PdfReader(str(path))
        page_count = len(reader.pages)
    except Exception:
        return SplitResult(original=req.file_path, parts=[req.file_path], split=False)

    if page_count > req.max_pages or file_size_mb > req.max_size_mb:
        needs_split = True

    if not needs_split:
        _close_reader(reader)
        return SplitResult(original=req.file_path, parts=[req.file_path], split=False)

    parts = []
    base = path.stem
    parent = path.parent
    part_num = 0

    try:
        for start in range(0, page_count, req.max_pages):
            part_num += 1
            writer = PdfWriter()
            end = min(start + req.max_pages, page_count)
            for i in range(start, end):
                writer.add_page(reader.pages[i])

            part_path = parent / f"{base}_part{part_num}.pdf"
            with open(part_path, "wb") as f:
                writer.write(f)
            parts.append(str(part_path))
    finally:
        _close_reader(reader)

    return SplitResult(original=req.file_path, parts=parts, split=True)


def _close_reader(reader):
    """Release file handles held by pypdf's PdfReader.

    On Windows, an open file stream prevents the file from being overwritten
    or deleted until the process exits, even after the PdfReader goes out of
    scope.  Explicitly closing the stream avoids the lock.
    """
    try:
        if hasattr(reader, "stream") and reader.stream:
            reader.stream.close()
    except Exception:
        pass


@router.post("/utils/clean-orphans")
def clean_orphans():
    """Clean up orphaned LanceDB tables, stale backups, and orphan documents."""
    from ..config import get_config

    config = get_config()
    data_dir = Path(config.knowledge_base_data_dir)
    results: list[str] = []

    # Load registry
    registry_ids: set[str] = set()
    registry_path = data_dir / "knowledge_bases.json"
    if registry_path.exists():
        try:
            data = json.loads(registry_path.read_text(encoding="utf-8"))
            for kb in data.get("knowledge_bases", []):
                registry_ids.add(kb["id"])
        except (json.JSONDecodeError, OSError):
            pass

    # 1. Remove LanceDB tables not in registry
    from ..db.lancedb_manager import LanceDBManager

    lancedb_dir = data_dir / "lancedb_data"
    try:
        db = LanceDBManager(lancedb_dir)
        try:
            lancedb_ids = db.list_kb_ids()
            for lid in lancedb_ids:
                if lid not in registry_ids:
                    try:
                        db.drop_table(lid)
                        results.append(f"Removed orphan LanceDB table: {lid}")
                    except Exception as e:
                        results.append(f"Error dropping {lid}: {e}")
        finally:
            db.close()
    except Exception as e:
        results.append(f"Error opening LanceDB: {e}")

    # 2. Remove orphan documents (dirs without metadata.json)
    for kb_id in registry_ids:
        docs_dir = data_dir / f"kb_{kb_id}" / "docs"
        if docs_dir.exists():
            for d in docs_dir.iterdir():
                if d.is_dir() and not (d / "metadata.json").exists():
                    try:
                        shutil.rmtree(d)
                        results.append(f"Removed orphan document dir: {kb_id}/{d.name}")
                    except Exception as e:
                        results.append(f"Error removing {d.name}: {e}")

    # 3. Remove stale .bak files
    if lancedb_dir.exists():
        for f in list(lancedb_dir.glob("*.bak")) + list(lancedb_dir.glob("*.bak.*")):
            try:
                f.unlink()
                results.append(f"Removed stale backup: {f.name}")
            except Exception as e:
                results.append(f"Error removing {f.name}: {e}")

    # 4. Repair kb_id mismatches in chunks (doesn't count towards "cleaned" total)
    try:
        db2 = LanceDBManager(lancedb_dir)
        repaired = 0
        try:
            for kb_id in registry_ids:
                table = db2.get_table(kb_id)
                if table is None:
                    continue
                try:
                    all_rows = table.search().limit(50000).to_list()
                    wrong_rows = [r for r in all_rows if r.get("kb_id") != kb_id]
                    if wrong_rows:
                        wrong_ids = [r["chunk_id"] for r in wrong_rows]
                        for i in range(0, len(wrong_ids), 200):
                            batch = wrong_ids[i:i+200]
                            id_list = "', '".join(batch)
                            table.delete(f"chunk_id IN ('{id_list}')")
                        for row in wrong_rows:
                            row["kb_id"] = kb_id
                        table.add(wrong_rows)
                        repaired += len(wrong_rows)
                        results.append(f"Fixed {len(wrong_rows)} kb_id mismatches in KB: {kb_id}")
                except Exception as e:
                    results.append(f"Error repairing {kb_id}: {e}")
        finally:
            db2.close()
    except Exception as e:
        results.append(f"Error in kb_id repair: {e}")

    # Return cleaned count (orphans removed) + repaired count separately
    actual_cleaned = sum(1 for r in results if "Removed" in r)
    return {"cleaned": actual_cleaned, "details": results}
