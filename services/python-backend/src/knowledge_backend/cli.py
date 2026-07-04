"""
SKB CLI — Terminal test tool for the Super Knowledge Base.

Usage:
    skb-cli                       Interactive REPL shell
    skb-cli <command> [args]      Single command mode

Commands:
    kb list                       List all knowledge bases
    kb use <kb_id>                Set current KB (REPL only)
    kb docs [kb_id]               List documents (uses current KB if set)

    doc view <kb_id> <doc_id>     View document with paging (n/p/g/q)
    doc page <kb_id> <doc_id> <n> Show chunks on page N
    doc chunks <kb_id> <doc_id>   List all chunks with page ranges

    search <kb_id> <query>        Hybrid search with rerank
    search-all <query>            Search across all KBs

    index <kb_id> <doc_id>        Re-index a document
    images <kb_id> <doc_id>       List images and their descriptions
    image-fill <kb_id> <doc_id>   Fill missing VLM descriptions
    clean-orphans                 Clean orphaned data
    page-map <kb_id> <doc_id>     Show PAGE marker distribution in chunks
"""

import cmd
import json
import os
import re
import shlex
import sys
import textwrap
import time
import uuid
from pathlib import Path
from typing import Optional

# ── rich imports (optional) ──
try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn
    from rich.text import Text
    from rich import print as rprint
    _HAS_RICH = True
    # Force utf-8 on Windows to avoid GBK encoding errors
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
except ImportError:
    _HAS_RICH = False


# ── shared helpers ──

def _print_table(headers: list[str], rows: list[list[str]], title: str = ""):
    """Print a table with rich (if available) or plain text."""
    if _HAS_RICH:
        try:
            console = Console()
            table = Table(title=title, show_header=True, header_style="bold")
            for h in headers:
                table.add_column(h, no_wrap=False)
            for row in rows:
                table.add_row(*[str(c) for c in row])
            console.print(table)
        except (UnicodeEncodeError, UnicodeDecodeError):
            # Fallback to plain text on Windows encoding issues
            _print_table_plain(headers, rows, title)
    else:
        _print_table_plain(headers, rows, title)


def _print_table_plain(headers: list[str], rows: list[list[str]], title: str = ""):
    """Plain ASCII table rendering."""
    if title:
        print(f"\n{title}")

    # Sanitize: replace non-ASCII chars that can't encode
    def _safe(s: str) -> str:
        return str(s).encode('ascii', errors='replace').decode('ascii')

    h = [_safe(x) for x in headers]
    r = [[_safe(str(c)) for c in row] for row in rows]

    widths = [max(len(row[i]) for row in r + [h]) for i in range(len(h))]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    print(fmt.format(*h))
    print("-" * (sum(widths) + 2 * (len(h) - 1)))
    for row in r:
        print(fmt.format(*row))


def _ellipsis(text: str, max_len: int = 120) -> str:
    return text[:max_len] + "..." if len(text) > max_len else text


def _page_of(text: str, page_size: int = 40) -> list[str]:
    """Split text into page_size-line pages."""
    lines = text.split("\n")
    pages = []
    for i in range(0, len(lines), page_size):
        pages.append("\n".join(lines[i:i + page_size]))
    return pages


# ── Backend glue ──

def _get_config():
    from knowledge_backend.config import get_config
    return get_config()


def _get_db():
    from knowledge_backend.db.lancedb_manager import LanceDBManager
    config = _get_config()
    return LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")


def _data_dir() -> Path:
    return Path(_get_config().knowledge_base_data_dir)


def _registry_path() -> Path:
    return _data_dir() / "knowledge_bases.json"


def _read_registry() -> list[dict]:
    rp = _registry_path()
    if not rp.exists():
        return []
    try:
        with open(rp, encoding="utf-8") as f:
            return json.load(f).get("knowledge_bases", [])
    except Exception:
        return []


def _kb_name(kb_id: str) -> str:
    for kb in _read_registry():
        if kb["id"] == kb_id:
            return kb.get("name", kb_id)
    return kb_id


# ── Command implementations ──

def cmd_kb_list():
    """List all knowledge bases."""
    config = _get_config()
    db = _get_db()
    try:
        lancedb_ids = set(db.list_kb_ids())
    finally:
        db.close()

    kbs = _read_registry()
    rows = []
    for kb in kbs:
        kid = kb["id"]
        rows.append([
            kb.get("name", ""),
            kid[:8],
            str(kb.get("document_count", 0)),
            str(kb.get("chunk_count", 0)),
            kb.get("embedding_model", ""),
            "yes" if kid in lancedb_ids else "no",
        ])

    # Also show orphan KBs in LanceDB
    for lid in lancedb_ids:
        if not any(kb["id"] == lid for kb in kbs):
            rows.append([f"[Orphan]", lid[:8], "?", "?", "?", "yes"])

    _print_table(
        ["Name", "ID", "Docs", "Chunks", "Embedding", "LanceDB"],
        rows,
        "Knowledge Bases",
    )


def cmd_kb_docs(kb_id: str):
    """List documents in a knowledge base."""
    docs_dir = _data_dir() / f"kb_{kb_id}" / "docs"
    if not docs_dir.exists():
        print(f"KB not found or no documents directory: {kb_id}")
        return

    rows = []
    for d in sorted(docs_dir.iterdir()):
        if not d.is_dir():
            continue
        meta_path = d / "metadata.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            name = meta.get("name", d.name)
            ftype = meta.get("file_type", "")
            size_kb = meta.get("file_size", 0) / 1024
            status = meta.get("parse_status", "?")
            cc = meta.get("chunk_count", 0)
            has_md = "yes" if (d / "full.md").exists() else "no"
            has_cl = "yes" if (d / "content_list.json").exists() else "no"
            rows.append([
                name[:50], d.name[:8], ftype, f"{size_kb:.0f}KB",
                status, str(cc), has_md, has_cl,
            ])
        except Exception:
            rows.append([d.name, d.name[:8], "?", "?", "error", "0", "?", "?"])

    _print_table(
        ["Name", "ID", "Type", "Size", "Status", "Chunks", "MD", "CL"],
        rows,
        f"Documents in {_kb_name(kb_id)}",
    )


def cmd_doc_view(kb_id: str, doc_id: str):
    """View document content with paging navigation."""
    md_path = _data_dir() / f"kb_{kb_id}" / "docs" / doc_id / "full.md"
    if not md_path.exists():
        print(f"Document not found or not parsed: {kb_id}/{doc_id}")
        return

    content = md_path.read_text(encoding="utf-8")
    pages = _page_of(content, 40)
    total_pages = len(pages)
    current = 0

    # Try to extract page info from PAGE markers
    page_markers = re.findall(r"\[PAGE:(\d+)(?:\|(-?\d+))?\]", pages[current])
    marker_info = f" (PAGE markers: {sorted(set(int(m[0]) for m in page_markers))[:10]})" if page_markers else ""

    print(f"\n--- Document: {_kb_name(kb_id)} / {doc_id} ---")
    print(f"--- Page {current + 1}/{total_pages} ({len(content)} chars){marker_info} ---")
    print(pages[current])
    print(f"--- [n]ext [p]rev [g N] jump [q]uit ---")

    while True:
        try:
            cmd = input().strip().lower()
        except (EOFError, KeyboardInterrupt):
            break

        if cmd in ("q", "quit"):
            break
        elif cmd in ("n", "next", ""):
            current = min(current + 1, total_pages - 1)
        elif cmd in ("p", "prev"):
            current = max(current - 1, 0)
        elif cmd.startswith("g "):
            try:
                target = int(cmd.split()[1])
                current = max(0, min(target - 1, total_pages - 1))
            except ValueError:
                print("Invalid page number")
                continue
        else:
            print("Unknown command: [n]ext [p]rev [g N] jump [q]uit")
            continue

        page_markers = re.findall(r"\[PAGE:(\d+)\]", pages[current])
        marker_info = f" (PAGE markers: {sorted(set(int(m) for m in page_markers))})" if page_markers else ""
        print(f"\n--- Page {current + 1}/{total_pages} ({len(content)} chars){marker_info} ---")
        print(pages[current])
        print(f"--- [n]ext [p]rev [g N] jump [q]uit ---")


def cmd_doc_page(kb_id: str, doc_id: str, page_num: int):
    """Show all chunks that cover a specific page number."""
    db = _get_db()
    try:
        chunks = db.get_chunks_by_page(kb_id, doc_id, page_num)
    finally:
        db.close()

    print(f"\n=== Chunks on page {page_num} of doc {doc_id} ===")
    if not chunks:
        print(f"  No chunks found for page {page_num}")
        return

    for c in chunks:
        ci = c.get("chunk_index", "?")
        ps = c.get("page_start", "?")
        pe = c.get("page_end", "?")
        content = c.get("content", "")[:300]
        print(f"\n  chunk_index={ci}  page_range=[{ps}-{pe}]")
        print(f"  {content}")


def cmd_doc_chunks(kb_id: str, doc_id: str):
    """List all chunks with their page ranges."""
    db = _get_db()
    try:
        table = db.get_table(kb_id)
        if table is None:
            print(f"KB not found: {kb_id}")
            return
        chunks = table.search().where(f"doc_id = '{doc_id}'").to_list()
        chunks.sort(key=lambda c: c.get("chunk_index", 0))
    finally:
        db.close()

    print(f"\n=== {len(chunks)} chunks in doc {doc_id} ===")
    rows = []
    for c in chunks:
        ci = c.get("chunk_index", "?")
        meta = {}
        try:
            meta = json.loads(c.get("metadata_json", "{}"))
        except Exception:
            pass
        ps = meta.get("page_start", c.get("page_number", "?"))
        pe = meta.get("page_end", c.get("page_number", "?"))
        ctype = meta.get("content_type", "text")
        content = _ellipsis(c.get("content", ""), 100)
        rows.append([str(ci), str(ps), str(pe), ctype, content])

    _print_table(
        ["Chunk", "PageFrom", "PageTo", "Type", "Content"],
        rows,
        f"Chunks in {doc_id[:8]}",
    )


def cmd_search(kb_id: str, query: str):
    """Hybrid search with optional rerank."""
    from knowledge_backend.embedding import OpenAICompatibleEmbedder
    from knowledge_backend.reranker import OpenAICompatibleReranker

    config = _get_config()
    db = _get_db()
    try:
        embedder = OpenAICompatibleEmbedder(
            config.embedding_api_base, config.embedding_api_key, config.embedding_model,
        )
        qv = embedder.embed_single(query)
        embedder.close()

        results = db.search(kb_id=kb_id, query_vector=qv, query_text=query,
                            search_type="hybrid", top_k=30)

        if config.rerank_api_key and results:
            try:
                reranker = OpenAICompatibleReranker(
                    config.rerank_api_base, config.rerank_api_key, config.rerank_model,
                )
                docs = [r["content"] for r in results]
                reranked = reranker.rerank(query, docs, top_n=10)
                reranker.close()
                new_results = []
                for rr in reranked[:10]:
                    if rr.index < len(results):
                        r = results[rr.index]
                        if len(r.get("content", "").strip()) >= 20:
                            r["score"] = rr.score
                            new_results.append(r)
                results = new_results
            except Exception:
                results = [r for r in results[:10] if len(r.get("content", "").strip()) >= 20]
        else:
            results = [r for r in results[:10] if len(r.get("content", "").strip()) >= 20]
    finally:
        db.close()

    print(f"\n=== Search: \"{query}\" in {_kb_name(kb_id)} ===\n")
    for i, r in enumerate(results):
        score = r.get("score", 0)
        ci = r.get("chunk_index", "?")
        doc_name = r.get("doc_name", "?")
        ps = r.get("page_start", "?")
        pe = r.get("page_end", "?")
        ctype = r.get("content_type", "text")
        content = r.get("content", "")[:250]
        print(f"[{i+1}] score={score:.3f}  chunk={ci}  page=[{ps}-{pe}]  type={ctype}  doc={doc_name[:30]}")
        print(f"    {content}\n")


def cmd_search_all(query: str):
    """Search across all knowledge bases."""
    from knowledge_backend.embedding import OpenAICompatibleEmbedder
    from knowledge_backend.reranker import OpenAICompatibleReranker

    config = _get_config()
    db = _get_db()
    try:
        kbs = _read_registry()
        kb_ids = [kb["id"] for kb in kbs if db.table_exists(kb["id"])]

        embedder = OpenAICompatibleEmbedder(
            config.embedding_api_base, config.embedding_api_key, config.embedding_model,
        )
        qv = embedder.embed_single(query)
        embedder.close()

        all_results = []
        for kid in kb_ids:
            try:
                results = db.search(kb_id=kid, query_vector=qv, query_text=query,
                                    search_type="hybrid", top_k=10)
                all_results.extend(results)
            except Exception:
                pass

        all_results.sort(key=lambda r: r.get("score", 0), reverse=True)
        all_results = all_results[:10]
    finally:
        db.close()

    print(f"\n=== Global Search: \"{query}\" ({len(kb_ids)} KBs) ===\n")
    for i, r in enumerate(all_results):
        score = r.get("score", 0)
        ci = r.get("chunk_index", "?")
        kb = r.get("kb_id", "?")[:8]
        ps = r.get("page_start", "?")
        content = r.get("content", "")[:200]
        print(f"[{i+1}] score={score:.3f}  KB={kb}  chunk={ci}  page={ps}")
        print(f"    {content}\n")


def cmd_index(kb_id: str, doc_id: str):
    """Re-index a document (parse content_list, chunk, embed, store)."""
    config = _get_config()
    doc_dir = _data_dir() / f"kb_{kb_id}" / "docs" / doc_id

    md_path = doc_dir / "full.md"
    if not md_path.exists():
        print(f"Error: full.md not found for {kb_id}/{doc_id}")
        return

    markdown = md_path.read_text(encoding="utf-8")
    doc_name = doc_id
    meta_path = doc_dir / "metadata.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            doc_name = meta.get("name", doc_id)
        except Exception:
            pass

    print(f"Indexing: {doc_name} ({len(markdown)} chars)")

    # ── Embedder ──
    from knowledge_backend.embedding import OpenAICompatibleEmbedder
    embedder = OpenAICompatibleEmbedder(
        config.embedding_api_base, config.embedding_api_key, config.embedding_model,
    )
    embedding_dim = embedder.get_dimension()
    print(f"  Embedding model: {config.embedding_model} (dim={embedding_dim})")

    # ── DB ──
    from knowledge_backend.db.lancedb_manager import LanceDBManager
    db = LanceDBManager(Path(config.knowledge_base_data_dir) / "lancedb_data")
    if not db.table_exists(kb_id):
        db.create_table(kb_id, embedding_dim)

    # ── Page markers ──
    from knowledge_backend.api.documents import _inject_page_markers, _extract_page_range, _compute_page_offset, _PAGE_MARKER_RE
    split_offset = _compute_page_offset(doc_dir, doc_name)
    # Read user-set page_offset from metadata
    user_offset = 0
    meta_path = doc_dir / "metadata.json"
    if meta_path.exists():
        try:
            doc_meta = json.loads(meta_path.read_text(encoding="utf-8"))
            user_offset = doc_meta.get("page_offset", 0)
        except Exception: pass
    page_offset = split_offset + user_offset
    tagged_md = _inject_page_markers(markdown, doc_dir)
    if split_offset > 0:
        tagged_md = _PAGE_MARKER_RE.sub(
            lambda m: f"[PAGE:{int(m.group(1)) + split_offset}]", tagged_md)

    # ── Chunking ──
    from knowledge_backend.chunker import Chunker
    chunker = Chunker.create(config.chunk_strategy, config.chunk_size, config.chunk_overlap)
    chunks = chunker.chunk(tagged_md, metadata={"doc_id": doc_id, "doc_name": doc_name},
                           page_mapper=None)
    # Split chunks that span multiple pages at PAGE marker boundaries.
    # Assign page from the marker directly.
    _split_chunks = []
    _copy_mod = __import__("copy")
    for c in chunks:
        markers = list(re.finditer(r"\[PAGE:(\d+)(?:\|(-?\d+))?\]", c.content))
        pages_seen = {int(m.group(1)) for m in markers}
        if len(pages_seen) <= 1:
            _split_chunks.append(c)
        else:
            leading = c.content[:markers[0].start()].strip()
            for i, m in enumerate(markers):
                start = m.end()
                end = markers[i + 1].start() if i + 1 < len(markers) else len(c.content)
                sub = c.content[start:end].strip()
                if i == 0 and leading:
                    sub = leading + "\n" + sub if sub else leading
                if sub:
                    nc = _copy_mod.deepcopy(c)
                    nc.content = sub
                    page = int(m.group(1))
                    nc.metadata["page"] = page
                    nc.metadata["page_start"] = page
                    nc.metadata["page_end"] = page
                    if m.group(2) is not None:
                        nc.metadata["start_char"] = int(m.group(2))
                    _split_chunks.append(nc)
    chunks = _split_chunks if _split_chunks else chunks

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
            c.content = re.sub(r"\[PAGE:\d+(?:\|-?\d+)?\]", "", c.content)
            ps = c.metadata["page_start"]
        # Track last_page BEFORE offset so continuation chunks
        # inherit the correct virtual page (not double-offset).
        if ps > 0:
            last_page = ps
        # Apply page_offset
        # Only user_offset here (split_offset already in PAGE markers)
        if user_offset:
            c.metadata["page"] = c.metadata["page"] - user_offset
            c.metadata["page_start"] = c.metadata["page_start"] - user_offset
            c.metadata["page_end"] = c.metadata["page_end"] - user_offset

    # ── Map chunk start_char (fallback for chunks without embedded pos) ──
    _search_from = 0
    for c in chunks:
        if "start_char" in c.metadata and isinstance(c.metadata.get("start_char"), int) and c.metadata["start_char"] >= 0:
            _search_from = max(_search_from, c.metadata["start_char"] + len(c.content))
        else:
            if c.content.strip():
                # Search from current position, but allow 256-char lookback
                # to catch continuation chunks whose text starts before
                # _search_from due to content_list ↔ markdown length diffs.
                lookback = max(0, _search_from - 256)
                idx = markdown.find(c.content, lookback)
                if idx < 0:
                    prefix = c.content[:80]
                    idx = markdown.find(prefix, lookback)
                if idx < 0 and _search_from > 0:
                    # Fallback: search from beginning
                    idx = markdown.find(c.content, 0)
                    if idx < 0:
                        idx = markdown.find(c.content[:80], 0)
                if idx >= 0:
                    c.metadata["start_char"] = idx
                    _search_from = idx + len(c.content)

    print(f"  Chunks: {len(chunks)}")

    # ── Multimodal chunks ──
    mm_chunks = []
    cl_path = doc_dir / "content_list.json"
    if cl_path.exists() and config.extract_multimodal:
        try:
            from knowledge_backend.page_mapper import extract_multimodal_items
            from knowledge_backend.chunker import multimodal_chunks_from_content_list
            cl_data = json.loads(cl_path.read_text(encoding="utf-8"))
            mm_items = extract_multimodal_items(cl_data)
            mm_chunks = multimodal_chunks_from_content_list(
                mm_items, metadata={"doc_id": doc_id, "doc_name": doc_name})
            # Convert 0-based page_idx to 1-based virtual pages, then
            # apply offsets consistent with text chunks.
            for c in mm_chunks:
                for key in ("page", "page_start", "page_end"):
                    val = c.metadata.get(key, 0)
                    if isinstance(val, int) and val >= 0:
                        c.metadata[key] = val + 1 + split_offset
            if user_offset:
                for c in mm_chunks:
                    for key in ("page", "page_start", "page_end"):
                        val = c.metadata.get(key, 0)
                        if isinstance(val, int):
                            c.metadata[key] = val - user_offset
            print(f"  Multimodal chunks: {len(mm_chunks)}")
        except Exception as e:
            print(f"  Multimodal chunks failed: {e}")

    all_chunks = chunks + mm_chunks

    # ── Embedding ──
    texts = [c.content for c in all_chunks]
    total = len(texts)
    all_vectors = []
    batch_size = 50
    for i in range(0, total, batch_size):
        batch = texts[i:i + batch_size]
        all_vectors.extend(embedder.embed(batch))
        if (i + batch_size) % 200 == 0 or i + batch_size >= total:
            print(f"  Embedding: {min(i + batch_size, total)}/{total}")

    embedder.close()

    # ── Store ──
    db.delete_document_chunks(kb_id, doc_id)
    count = db.insert_chunks(kb_id, all_chunks, all_vectors, doc_id, doc_name,
                             chunk_strategy=config.chunk_strategy)
    db.close()
    print(f"  Stored: {count} chunks")

    # Update doc metadata
    if meta_path.exists():
        try:
            meta["chunk_count"] = count
            meta["embedding_model"] = config.embedding_model
            meta["embedding_dim"] = embedding_dim
            meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    # Page distribution
    page_counts: dict[int, int] = {}
    for c in all_chunks:
        ps = c.metadata.get("page_start", 0)
        page_counts[ps] = page_counts.get(ps, 0) + 1
    pages = sorted(page_counts.keys())
    print(f"  Page coverage: {pages[:5]}...{pages[-3:]} ({len(pages)} unique pages)")
    print("Done.")


def cmd_images(kb_id: str, doc_id: str):
    """List images and their descriptions."""
    doc_dir = _data_dir() / f"kb_{kb_id}" / "docs" / doc_id
    img_dir = doc_dir / "images"
    if not img_dir.exists():
        print(f"No images directory for {doc_id}")
        return

    # Load descriptions
    descs: dict[str, str] = {}
    meta_path = doc_dir / "images_meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            for fname, info in meta.items():
                if isinstance(info, dict):
                    descs[fname] = info.get("description", "")
        except Exception:
            pass

    # Load content_list to identify real images vs formulas
    real_images: set[str] = set()
    cl_path = doc_dir / "content_list.json"
    if cl_path.exists():
        try:
            from knowledge_backend.page_mapper import extract_multimodal_items
            cl_data = json.loads(cl_path.read_text(encoding="utf-8"))
            for mi in extract_multimodal_items(cl_data):
                if mi.get("type") in ("image", "picture", "chart"):
                    name = mi.get("img_path", "").split("/")[-1]
                    if name:
                        real_images.add(name)
        except Exception:
            pass

    rows = []
    missing = 0
    img_files = sorted(img_dir.iterdir()) if real_images else []
    if not real_images:
        # Fallback: all image files
        img_files = sorted(img_dir.iterdir())

    for f in img_files:
        if real_images and f.name not in real_images:
            continue
        desc = descs.get(f.name, "")
        valid = "yes" if desc and desc not in ("[Image - no description available]", "Image") else "no"
        if valid == "no":
            missing += 1
        rows.append([f.name[:40], f"{f.stat().st_size / 1024:.0f}KB", valid, _ellipsis(desc, 60)])

    _print_table(
        ["Filename", "Size", "Desc", "Description"],
        rows[:100],  # limit to 100
        f"Images in {doc_id[:8]} ({len(rows)} total, {missing} missing description)",
    )


def cmd_image_fill(kb_id: str, doc_id: str):
    """Fill missing VLM image descriptions."""
    from knowledge_backend.api.documents import DescribeImageRequest, fill_missing_images
    from knowledge_backend.api.documents import _fill_tasks, _fill_tasks_lock
    import time as _time

    try:
        req = DescribeImageRequest(kb_id=kb_id, doc_id=doc_id, filename="_")
        result = fill_missing_images(req)
    except Exception as e:
        print(f"Error: {e}")
        return

    if result.get("done"):
        print(result.get("message", "Done"))
        return

    task_id = result["task_id"]
    total = result.get("total", 0)
    print(f"Started fill task {task_id[:8]}... ({total} images to process)")
    print("Polling progress (Ctrl+C to stop, task continues in background)...")

    try:
        while True:
            _time.sleep(1)
            with _fill_tasks_lock:
                task = _fill_tasks.get(task_id, {})
            if not task:
                break
            current = task.get("current", 0)
            total_t = task.get("total", 0)
            name = task.get("current_name", "")
            msg = task.get("message", "")
            done = task.get("done", False)
            pct = round(current / max(1, total_t) * 100)
            bar = "#" * (pct // 2) + "-" * (50 - pct // 2)
            print(f"\r  [{bar}] {pct}% {current}/{total_t} {name} {msg}", end="")
            if done:
                print()
                filled = task.get("filled", 0)
                failed = task.get("failed", 0)
                failed_details = task.get("failed_details", [])
                print(f"Done: {filled} filled, {failed} failed")
                for fd in failed_details:
                    print(f"  FAILED: {fd.get('name', '?')} -- {fd.get('error', '?')}")
                break
    except KeyboardInterrupt:
        print("\nPolling stopped (task continues in background)")


def cmd_clean_orphans():
    """Clean orphaned LanceDB tables, docs, and chunks."""
    import shutil
    print("Cleaning orphaned data...")
    data_dir = _data_dir()
    registry_path = data_dir / "knowledge_bases.json"

    registry_ids: set[str] = set()
    if registry_path.exists():
        try:
            reg = json.loads(registry_path.read_text(encoding="utf-8"))
            registry_ids = {kb["id"] for kb in reg.get("knowledge_bases", [])}
        except Exception:
            pass

    cleaned = 0
    details: list[str] = []

    # Clean LanceDB orphan tables
    lancedb_dir = data_dir / "lancedb_data"
    if lancedb_dir.exists():
        db = _get_db()
        try:
            for lid in db.list_kb_ids():
                if lid not in registry_ids:
                    try:
                        db.drop_table(lid)
                        cleaned += 1
                        details.append(f"Dropped orphan LanceDB table: {lid}")
                    except Exception as e:
                        details.append(f"Failed to drop {lid}: {e}")
        finally:
            db.close()

    # Clean orphan documents (dirs without metadata.json)
    for kb_dir in data_dir.glob("kb_*"):
        docs_dir = kb_dir / "docs"
        if docs_dir.exists():
            for d in docs_dir.iterdir():
                if d.is_dir() and not (d / "metadata.json").exists():
                    try:
                        shutil.rmtree(d)
                        cleaned += 1
                        details.append(f"Removed orphan doc dir: {d}")
                    except Exception as e:
                        details.append(f"Failed to remove {d}: {e}")

    # Clean .bak LanceDB tables
    if lancedb_dir.exists():
        for bak in lancedb_dir.glob("*.bak"):
            try:
                shutil.rmtree(bak)
                cleaned += 1
                details.append(f"Removed .bak: {bak}")
            except Exception as e:
                details.append(f"Failed to remove {bak}: {e}")

    # Clean orphan chunks (chunks whose doc dirs don't have full.md)
    for kb_id in list(registry_ids):
        db = _get_db()
        try:
            table = db.get_table(kb_id)
            if table is None:
                continue
            rows = table.search().limit(50000).to_list()
            for r in rows:
                did = r.get("doc_id", "")
                md_path = data_dir / f"kb_{kb_id}" / "docs" / did / "full.md"
                if not md_path.exists():
                    db.delete_document_chunks(kb_id, did)
                    cleaned += 1
                    details.append(f"Cleaned orphan chunks for doc {did} in KB {kb_id}")
        except Exception:
            pass
        finally:
            db.close()

    result = {"cleaned": cleaned, "details": details}
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_page_offset(kb_id: str, doc_id: str, new_offset: str = ""):
    """Get or set the page offset for a document.

    page_offset = N means: virtual page N+1 should be displayed as page 1.
    Set to 0 to use virtual page numbers (default)."""
    doc_dir = _data_dir() / f"kb_{kb_id}" / "docs" / doc_id
    meta_path = doc_dir / "metadata.json"
    if not meta_path.exists():
        print(f"Document not found: {doc_id}")
        return

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    current = meta.get("page_offset", 0)

    if new_offset == "":
        print(f"page_offset = {current}")
        if current > 0:
            print(f"  Virtual page {current + 1} → displayed as page 1")
    else:
        try:
            val = int(new_offset)
            meta["page_offset"] = val
            meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"page_offset: {current} → {val}")
            if val > 0:
                print(f"  Virtual page {val + 1} → displayed as page 1")
            print("Re-index the document for this to take effect.")
        except ValueError:
            print(f"Invalid offset: {new_offset}")


def cmd_page_map(kb_id: str, doc_id: str):
    """Show PAGE marker distribution across chunks — useful for debugging page mapping."""
    db = _get_db()
    try:
        table = db.get_table(kb_id)
        if table is None:
            print(f"KB not found: {kb_id}")
            return
        chunks = table.search().where(f"doc_id = '{doc_id}'").to_list()
        chunks.sort(key=lambda c: c.get("chunk_index", 0))
    finally:
        db.close()

    if not chunks:
        print("No chunks found. Has this document been indexed?")
        return

    # Analyze page distribution
    pages_seen: set[int] = set()
    first_chunk_per_page: dict[int, int] = {}
    for c in chunks:
        meta = {}
        try:
            meta = json.loads(c.get("metadata_json", "{}"))
        except Exception:
            pass
        ps = meta.get("page_start", c.get("page_number", "?"))
        if isinstance(ps, int):
            pages_seen.add(ps)
            if ps not in first_chunk_per_page:
                first_chunk_per_page[ps] = c.get("chunk_index", 0)

    all_pages = sorted(pages_seen)
    print(f"\n=== Page Map: {doc_id[:8]} in {_kb_name(kb_id)} ===")
    print(f"Total chunks: {len(chunks)}")
    print(f"Unique pages: {len(all_pages)}")
    print(f"Page range: {all_pages[0] if all_pages else '?'} → {all_pages[-1] if all_pages else '?'}")

    # Show first and last chunks
    rows = []
    for c in chunks[:5] + chunks[-3:]:
        ci = c.get("chunk_index", "?")
        meta = {}
        try:
            meta = json.loads(c.get("metadata_json", "{}"))
        except Exception:
            pass
        ps = meta.get("page_start", "?")
        pe = meta.get("page_end", "?")
        content = _ellipsis(c.get("content", ""), 80)
        rows.append([str(ci), str(ps), str(pe), content])

    _print_table(
        ["Chunk", "PageFrom", "PageTo", "Content"],
        rows,
        f"Sample chunks (first 5 + last 3)",
    )

    # Check for PAGE markers in chunk content
    marker_count = sum(1 for c in chunks if "[PAGE:" in c.get("content", ""))
    print(f"\nChunks with [PAGE:] markers in content: {marker_count}/{len(chunks)}")
    if marker_count > 0:
        print("  (Markers should have been stripped — these chunks have stale content)")


# ── REPL Shell ──

class SKBShell(cmd.Cmd):
    """Interactive SKB command shell."""

    intro = "SKB CLI — type 'help' for commands, 'quit' to exit."
    prompt = "skb> "
    _current_kb: Optional[str] = None

    def do_kb(self, arg: str):
        """kb list | kb use <id> | kb docs [id]"""
        args = shlex.split(arg)
        if not args:
            return self.help_topic("kb")
        sub = args[0]
        if sub == "list":
            cmd_kb_list()
        elif sub == "use" and len(args) > 1:
            self._current_kb = args[1]
            print(f"Current KB set to: {_kb_name(args[1])} ({args[1][:8]})")
        elif sub == "docs":
            kid = args[1] if len(args) > 1 else self._current_kb
            if kid:
                cmd_kb_docs(kid)
            else:
                print("No KB selected. Use 'kb use <id>' first.")
        else:
            print(f"Unknown kb subcommand: {sub}")

    def complete_kb(self, text: str, line: str, begidx: int, endidx: int) -> list[str]:
        parts = line.split()
        if len(parts) <= 2 or (len(parts) == 2 and not text):
            return [s for s in ["list", "use", "docs"] if s.startswith(text)]
        return []

    def do_docs(self, arg: str):
        """List documents in current KB"""
        if self._current_kb:
            cmd_kb_docs(self._current_kb)
        else:
            print("No KB selected. Use 'kb use <id>' first.")

    def do_doc(self, arg: str):
        """doc view <doc_id> | doc page <doc_id> <page> | doc chunks <doc_id>"""
        args = shlex.split(arg)
        if len(args) < 2:
            print("Usage: doc view <doc_id> | doc page <doc_id> <page> | doc chunks <doc_id>")
            return
        sub = args[0]
        kid = self._current_kb
        if not kid:
            print("No KB selected. Use 'kb use <id>' first.")
            return
        if sub == "view":
            cmd_doc_view(kid, args[1])
        elif sub == "page" and len(args) > 2:
            cmd_doc_page(kid, args[1], int(args[2]))
        elif sub == "chunks":
            cmd_doc_chunks(kid, args[1])
        else:
            print(f"Unknown doc subcommand: {sub}")

    def complete_doc(self, text: str, line: str, begidx: int, endidx: int) -> list[str]:
        parts = line.split()
        if len(parts) <= 2:
            return [s for s in ["view", "page", "chunks"] if s.startswith(text)]
        return []

    def do_search(self, arg: str):
        """search <query> — search current KB"""
        if not self._current_kb:
            print("No KB selected. Use 'kb use <id>' first.")
            return
        if not arg.strip():
            print("Usage: search <query>")
            return
        cmd_search(self._current_kb, arg.strip())

    def do_page(self, arg: str):
        """page <N> — show chunks on a specific page of last-viewed doc"""
        print("Use 'doc page <doc_id> <page>' instead.")

    def do_index(self, arg: str):
        """index <doc_id> — re-index a document in current KB"""
        if not self._current_kb:
            print("No KB selected. Use 'kb use <id>' first.")
            return
        if not arg.strip():
            print("Usage: index <doc_id>")
            return
        cmd_index(self._current_kb, arg.strip())

    def do_images(self, arg: str):
        """images <doc_id> — list images"""
        if not self._current_kb:
            print("No KB selected. Use 'kb use <id>' first.")
            return
        if not arg.strip():
            print("Usage: images <doc_id>")
            return
        cmd_images(self._current_kb, arg.strip())

    def do_fill(self, arg: str):
        """fill <doc_id> — fill missing image descriptions"""
        if not self._current_kb:
            print("No KB selected. Use 'kb use <id>' first.")
            return
        if not arg.strip():
            print("Usage: fill <doc_id>")
            return
        cmd_image_fill(self._current_kb, arg.strip())

    def do_start(self, arg: str):
        """Start the Python backend server."""
        cmd_start_backend()

    def do_stop(self, arg: str):
        """Stop the Python backend server."""
        cmd_stop_backend()

    def do_restart(self, arg: str):
        """Restart the Python backend server."""
        cmd_restart_backend()

    def do_clean(self, arg: str):
        """clean-orphans"""
        cmd_clean_orphans()

    def do_offset(self, arg: str):
        """offset <doc_id> [new_value] — get/set page offset"""
        if not self._current_kb:
            print("No KB selected. Use 'kb use <id>' first.")
            return
        args = shlex.split(arg)
        if not args:
            print("Usage: offset <doc_id> [new_value]")
            return
        cmd_page_offset(self._current_kb, args[0], args[1] if len(args) > 1 else "")

    def do_page_map(self, arg: str):
        """page-map <doc_id> — show PAGE marker distribution"""
        if not self._current_kb:
            print("No KB selected. Use 'kb use <id>' first.")
            return
        if not arg.strip():
            print("Usage: page-map <doc_id>")
            return
        cmd_page_map(self._current_kb, arg.strip())

    def do_quit(self, arg: str):
        """Exit the shell."""
        print("Bye.")
        return True

    def do_exit(self, arg: str):
        """Exit the shell."""
        return self.do_quit(arg)

    def do_EOF(self, arg: str):
        """Exit on Ctrl+D."""
        print()
        return True

    def help_topic(self, topic: str = ""):
        if topic == "kb":
            print("kb list           List all knowledge bases")
            print("kb use <id>       Set current KB")
            print("kb docs [id]      List documents (uses current KB)")
        else:
            print("Commands:")
            print("  kb list | kb use <id> | kb docs [id]")
            print("  docs                           List docs in current KB")
            print("  doc view <id> | doc page <id> <n> | doc chunks <id>")
            print("  search <query>                 Search current KB")
            print("  index <doc_id>                 Re-index a document")
            print("  images <doc_id>                List images and descriptions")
            print("  fill <doc_id>                  Fill missing VLM descriptions")
            print("  page-map <doc_id>              Show PAGE marker distribution")
            print("  start-backend                  Start backend server")
            print("  stop-backend                   Stop backend server")
            print("  restart-backend                Restart backend server")
            print("  clean-orphans                  Clean orphaned data")
            print("  quit | exit                    Exit")

    def default(self, line: str):
        print(f"Unknown command: {line}. Type 'help' for commands.")


def cmd_stop_backend():
    """Stop the Python backend server."""
    import subprocess

    config = _get_config()
    port = config.knowledge_backend_port or 17390

    print(f"Looking for backend process on port {port}...")
    killed = False
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True, text=True,
        )
        for line in result.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.strip().split()
                pid = parts[-1]
                print(f"  Killing PID {pid} on port {port}...")
                subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
                killed = True
    except Exception as e:
        print(f"  Failed: {e}")

    if killed:
        print("Backend stopped.")
    else:
        print(f"No process found on port {port}.")


def cmd_start_backend():
    """Start the Python backend server (no-op if already running)."""
    import subprocess

    config = _get_config()
    port = config.knowledge_backend_port or 17390

    # Check if already running
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True, text=True,
        )
        for line in result.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                print(f"Backend already running on port {port}.")
                return
    except Exception:
        pass

    print(f"Starting backend on port {port}...")
    try:
        backend_exe = Path(sys.executable).parent / "knowledge-backend.exe"
        if not backend_exe.exists():
            subprocess.Popen(
                [sys.executable, "-m", "knowledge_backend.main"],
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        else:
            subprocess.Popen(
                [str(backend_exe)],
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        print(f"  Backend starting on port {port}...")
    except Exception as e:
        print(f"  Failed to start backend: {e}")


def cmd_restart_backend():
    """Restart the Python backend server."""
    import subprocess
    import signal

    config = _get_config()
    port = config.knowledge_backend_port or 17390

    print(f"Looking for backend process on port {port}...")
    killed = False
    try:
        # Windows: use netstat to find PID
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True, text=True,
        )
        for line in result.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.strip().split()
                pid = parts[-1]
                print(f"  Killing PID {pid} on port {port}...")
                subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
                killed = True
                import time
                time.sleep(1)
    except Exception as e:
        print(f"  Failed to kill backend: {e}")

    if killed:
        print("  Backend stopped.")

    # Start new backend
    print("Starting backend...")
    try:
        # Find the knowledge-backend executable
        backend_exe = Path(sys.executable).parent / "knowledge-backend.exe"
        if not backend_exe.exists():
            # Try to start via python module
            subprocess.Popen(
                [sys.executable, "-m", "knowledge_backend.main"],
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        else:
            subprocess.Popen(
                [str(backend_exe)],
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        print(f"  Backend starting on port {port}...")
    except Exception as e:
        print(f"  Failed to start backend: {e}")


# ── Main entry ──

def _print_usage():
    print(__doc__)
    print("Examples:")
    print("  skb-cli                              # Interactive shell")
    print("  skb-cli kb list                      # List all KBs")
    print("  skb-cli kb docs <kb_id>              # List documents")
    print("  skb-cli doc view <kb_id> <doc_id>    # View document")
    print("  skb-cli doc page <kb_id> <doc_id> 42 # Show page 42")
    print("  skb-cli doc chunks <kb_id> <doc_id>  # List chunks")
    print("  skb-cli search <kb_id> <query>       # Search")
    print("  skb-cli search-all <query>           # Global search")
    print("  skb-cli index <kb_id> <doc_id>       # Re-index")
    print("  skb-cli images <kb_id> <doc_id>      # Image list")
    print("  skb-cli image-fill <kb_id> <doc_id>  # Fill VLM descriptions")
    print("  skb-cli restart-backend              # Restart backend server")
    print("  skb-cli clean-orphans                # Clean orphans")
    print("  skb-cli page-map <kb_id> <doc_id>    # Page map debug")


def main():
    args = sys.argv[1:]

    if not args:
        # Interactive REPL
        SKBShell().cmdloop()
        return

    cmd_name = args[0]

    if cmd_name == "kb":
        if len(args) < 2:
            _print_usage()
        elif args[1] == "list":
            cmd_kb_list()
        elif args[1] == "docs" and len(args) > 2:
            cmd_kb_docs(args[2])
        else:
            _print_usage()

    elif cmd_name == "doc":
        if len(args) < 4:
            _print_usage()
        elif args[1] == "view":
            cmd_doc_view(args[2], args[3])
        elif args[1] == "page" and len(args) > 4:
            cmd_doc_page(args[2], args[3], int(args[4]))
        elif args[1] == "chunks":
            cmd_doc_chunks(args[2], args[3])
        else:
            _print_usage()

    elif cmd_name == "search" and len(args) > 2:
        cmd_search(args[1], " ".join(args[2:]))

    elif cmd_name == "search-all" and len(args) > 1:
        cmd_search_all(" ".join(args[1:]))

    elif cmd_name == "index" and len(args) > 2:
        cmd_index(args[1], args[2])

    elif cmd_name == "images" and len(args) > 2:
        cmd_images(args[1], args[2])

    elif cmd_name == "image-fill" and len(args) > 2:
        cmd_image_fill(args[1], args[2])

    elif cmd_name == "start-backend":
        cmd_start_backend()

    elif cmd_name == "stop-backend":
        cmd_stop_backend()

    elif cmd_name == "restart-backend":
        cmd_restart_backend()

    elif cmd_name == "clean-orphans":
        cmd_clean_orphans()

    elif cmd_name == "page-offset" and len(args) > 2:
        cmd_page_offset(args[1], args[2], args[3] if len(args) > 3 else "")

    elif cmd_name == "page-map" and len(args) > 2:
        cmd_page_map(args[1], args[2])

    elif cmd_name in ("-h", "--help", "help"):
        _print_usage()
    else:
        _print_usage()


if __name__ == "__main__":
    main()
