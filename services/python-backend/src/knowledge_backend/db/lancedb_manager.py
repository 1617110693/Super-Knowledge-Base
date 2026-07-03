"""LanceDB operations: table lifecycle, hybrid search, chunk insertion."""
import json
from pathlib import Path
from typing import List, Optional

import lancedb

from ..chunker import Chunk
from .schemas import get_chunk_schema


class LanceDBManager:
    """Manages LanceDB tables for knowledge bases."""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._db: lancedb.DBConnection | None = None

    @property
    def db(self) -> lancedb.DBConnection:
        if self._db is None:
            self._db = lancedb.connect(str(self.data_dir))
        return self._db

    @staticmethod
    def table_name(kb_id: str) -> str:
        return f"kb_{kb_id.replace('-', '_')}"

    def create_table(self, kb_id: str, embedding_dim: int) -> lancedb.table.Table:
        """Create a new LanceDB table for a knowledge base."""
        schema = get_chunk_schema(embedding_dim)
        table = self.db.create_table(
            self.table_name(kb_id), schema=schema, mode="overwrite"
        )
        try:
            table.create_fts_index("content")
        except Exception:
            pass
        return table

    def drop_table(self, kb_id: str):
        """Delete a knowledge base table."""
        self.db.drop_table(self.table_name(kb_id))

    def table_exists(self, kb_id: str) -> bool:
        return self.table_name(kb_id) in self.db.table_names()

    def get_table(self, kb_id: str) -> Optional[lancedb.table.Table]:
        if self.table_exists(kb_id):
            return self.db.open_table(self.table_name(kb_id))
        return None

    def delete_document_chunks(self, kb_id: str, doc_id: str):
        """Remove all chunks belonging to a document."""
        table = self.get_table(kb_id)
        if table is None:
            return
        try:
            table.delete(f"doc_id = '{doc_id}'")
        except Exception:
            pass

    def insert_chunks(
        self,
        kb_id: str,
        chunks: List[Chunk],
        vectors: List[List[float]],
        doc_id: str,
        doc_name: str,
        chunk_strategy: str = "recursive",
    ) -> int:
        """Insert chunks with their vectors into the knowledge base table."""
        table = self.get_table(kb_id)
        if table is None:
            raise ValueError(f"Knowledge base table not found: {kb_id}")

        # Delete existing chunks for this document to prevent duplicates
        self.delete_document_chunks(kb_id, doc_id)

        rows = []
        for chunk, vector in zip(chunks, vectors):
            rows.append(
                {
                    "chunk_id": f"{doc_id}-chunk-{chunk.chunk_index}",
                    "doc_id": doc_id,
                    "kb_id": kb_id,
                    "doc_name": doc_name,
                    "content": chunk.content,
                    "chunk_index": chunk.chunk_index,
                    "page_number": chunk.metadata.get("page", 0),
                    "chunk_strategy": chunk_strategy,
                    "metadata_json": json.dumps(chunk.metadata),
                    "vector": [float(v) for v in vector],
                }
            )

        table.add(rows)
        return len(rows)

    def search(
        self,
        kb_id: str,
        query_vector: List[float],
        query_text: str = "",
        search_type: str = "hybrid",
        top_k: int = 10,
        doc_id_filter: Optional[str] = None,
    ) -> List[dict]:
        """Search the knowledge base with vector, FTS, or hybrid search."""
        table = self.get_table(kb_id)
        if table is None:
            return []

        if search_type == "fts":
            return self._fts_search(table, query_text, top_k, doc_id_filter)
        elif search_type == "vector":
            return self._vector_search(table, query_vector, top_k, doc_id_filter)
        else:
            return self._hybrid_search(
                table, query_vector, query_text, top_k, doc_id_filter
            )

    # CJK Unicode ranges
    _CJK_RANGES = [
        (0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0xF900, 0xFAFF),
        (0x2E80, 0x2EFF), (0x3000, 0x303F), (0x31C0, 0x31EF),
    ]

    @classmethod
    def _has_cjk(cls, text: str) -> bool:
        return any(
            any(lo <= ord(ch) <= hi for lo, hi in cls._CJK_RANGES)
            for ch in text
        )

    @classmethod
    def _cjk_bigrams(cls, text: str) -> list[str]:
        """Split CJK text into character bigrams for keyword matching."""
        chars = [ch for ch in text if cls._has_cjk(ch)]
        if len(chars) < 2:
            return chars
        return [chars[i] + chars[i + 1] for i in range(len(chars) - 1)]

    def _keyword_search(self, table, query_text: str, top_k: int, doc_id_filter: Optional[str] = None) -> List[dict]:
        """Chinese-aware keyword search: uses bigram matching for CJK, falls back to FTS for non-CJK."""
        try:
            # Try built-in FTS first (works well for English)
            try:
                results = table.search(query_text, query_type="fts").limit(top_k * 2)
                if doc_id_filter:
                    results = results.where(f"doc_id = '{doc_id_filter}'")
                fts_results = results.limit(top_k * 2).to_list()
                if fts_results:
                    return self._format_results(fts_results[:top_k], "fts")
            except Exception:
                pass

            # Chinese bigram fallback: load content into memory and match
            if self._has_cjk(query_text):
                bigrams = self._cjk_bigrams(query_text)
                if not bigrams:
                    return []

                # Get all chunks and score by bigram match count
                try:
                    scan = table.search().limit(10000)
                    if doc_id_filter:
                        scan = scan.where(f"doc_id = '{doc_id_filter}'")
                    all_rows = scan.to_list()
                except Exception:
                    return []

                scored = []
                query_lower = query_text.lower()
                for r in all_rows:
                    content = r.get("content", "")
                    score = 0.0
                    # Count bigram matches
                    for bg in bigrams:
                        if bg in content:
                            score += 1.0
                    # Bonus for exact substring match
                    if query_text in content:
                        score += len(query_text) * 0.5
                    # Also check case-insensitive for ASCII portions
                    ascii_part = "".join(ch for ch in query_text if ord(ch) < 128).strip()
                    if ascii_part and ascii_part.lower() in content.lower():
                        score += len(ascii_part) * 0.3

                    if score > 0:
                        scored.append((r, score / max(len(bigrams), 1)))

                scored.sort(key=lambda x: x[1], reverse=True)
                return self._format_results([r for r, _ in scored[:top_k]], "fts")
            return []
        except Exception:
            return []

    def _vector_search(self, table, query_vector, top_k, doc_id_filter):
        try:
            results = table.search(query_vector).metric("cosine").limit(top_k * 2)
            if doc_id_filter:
                results = results.where(f"doc_id = '{doc_id_filter}'")
            return self._format_results(results.limit(top_k).to_list(), "vector")
        except Exception as e:
            # Vector dimension mismatch or other schema issue — return empty
            import sys
            print(f"[SKB] Vector search skipped: {e}", file=sys.stderr)
            return []

    def _fts_search(self, table, query_text, top_k, doc_id_filter):
        return self._keyword_search(table, query_text, top_k, doc_id_filter)

    def _hybrid_search(
        self, table, query_vector, query_text, top_k, doc_id_filter
    ):
        """Keyword-first hybrid: FTS provides the primary ranking.
        Vector results only boost items also found by keyword, or fill gaps."""
        fts_results = []
        if query_text:
            fts_results = self._fts_search(table, query_text, top_k * 2, doc_id_filter)

        # If keyword has good results, use keyword-first ranking
        if fts_results:
            fts_ids = {r["chunk_id"] for r in fts_results}
            # Get vector results to find semantic matches that keyword missed
            vector_results = self._vector_search(table, query_vector, top_k * 2, doc_id_filter)
            # Separate: overlap (keyword + vector agree) vs vector-only
            overlap = [r for r in vector_results if r["chunk_id"] in fts_ids]
            vector_only = [r for r in vector_results if r["chunk_id"] not in fts_ids]

            # Base: keyword results (already sorted by keyword score)
            merged = list(fts_results)
            merged_ids = set(r["chunk_id"] for r in merged)

            # Boost items that keyword AND vector agree on
            for r in overlap:
                if r["score"] > 0.5:  # only boost if vector is confident
                    for m in merged:
                        if m["chunk_id"] == r["chunk_id"]:
                            m["score"] = m["score"] * 1.5  # significant boost
                            break

            # Append vector-only if we have space (low-confidence semantic matches)
            vector_only.sort(key=lambda x: x.get("score", 0), reverse=True)
            for r in vector_only:
                if len(merged) >= top_k:
                    break
                if r.get("score", 0) > 0.7:  # only add if vector is very confident
                    r["score"] = r["score"] * 0.5  # de-weighted
                    merged.append(r)

            merged.sort(key=lambda x: x.get("score", 0), reverse=True)
            return merged[:top_k]

        # No keyword results: fall back to vector only
        return self._vector_search(table, query_vector, top_k, doc_id_filter)

    def _merge_hybrid_results(self, vector_results, fts_results, top_k):
        """Legacy merge — kept for API compatibility, not used by new hybrid."""
        return fts_results[:top_k]

    def _format_results(self, raw_results: List[dict], source: str) -> List[dict]:
        formatted = []
        for i, r in enumerate(raw_results):
            content = r.get("content", "")
            metadata = {}
            try:
                metadata = json.loads(r.get("metadata_json", "{}"))
            except (json.JSONDecodeError, TypeError):
                pass
            # Surface LanceDB columns into metadata so downstream code
            # (e.g. enrich_with_context) can access them consistently.
            metadata.setdefault("chunk_index", r.get("chunk_index"))
            metadata.setdefault("page", r.get("page_number"))
            # page_start / page_end are stored in metadata_json; surface them
            # from there (not as separate LanceDB columns)
            if "page_start" not in metadata:
                metadata["page_start"] = r.get("page_number", 0)
            if "page_end" not in metadata:
                metadata["page_end"] = r.get("page_number", 0)
            # _distance is a dissimilarity measure (lower = better match).
            # For cosine: range [0, 2] where 0=identical, 2=opposite.
            # Convert to 0–1 similarity: (2.0 - distance) / 2.0
            distance = float(r.get("_distance", 0))
            score = (2.0 - distance) / 2.0
            ctype = metadata.get("content_type", "text")
            formatted.append(
                {
                    "chunk_id": r.get("chunk_id", ""),
                    "doc_id": r.get("doc_id", ""),
                    "kb_id": r.get("kb_id", ""),
                    "doc_name": r.get("doc_name", ""),
                    "content": content,
                    "chunk_index": metadata.get("chunk_index"),
                    "page_number": metadata.get("page", 0),
                    "page_start": metadata.get("page_start", 0),
                    "page_end": metadata.get("page_end", 0),
                    "content_type": ctype,
                    "score": score,
                    "metadata": metadata,
                }
            )
        # Post-filter: remove parsing artifact chunks.
        # Non-text chunks (image/table/equation) may have short content
        # so we only apply the min-length check to text chunks.
        return [
            r for r in formatted
            if r["content_type"] != "text" or len(r["content"].strip()) >= 20
        ]

    def enrich_with_context(
        self,
        results: List[dict],
        kb_id: str,
        context_window: int = 0,
    ) -> List[dict]:
        """For each search result, attach neighboring chunks (prev/next context).

        When context_window > 0, queries the table for chunks with the same
        doc_id and chunk_index in [current - window, current + window],
        excluding the matched chunk itself. This gives the LLM or UI more
        surrounding context around each hit.
        """
        if context_window <= 0 or not results:
            return results

        table = self.get_table(kb_id)
        if table is None:
            return results

        # Collect all (doc_id, chunk_index) pairs that need neighbors
        needs_neighbors: dict[str, set[int]] = {}
        for r in results:
            doc_id = r.get("doc_id", "")
            chunk_idx = r.get("metadata", {}).get("chunk_index")
            if not doc_id or chunk_idx is None:
                continue
            if doc_id not in needs_neighbors:
                needs_neighbors[doc_id] = set()
            for offset in range(-context_window, context_window + 1):
                if offset == 0:
                    continue
                needs_neighbors[doc_id].add(chunk_idx + offset)

        if not needs_neighbors:
            return results

        # Batch-fetch all needed neighbor chunks per document
        neighbor_cache: dict[tuple[str, int], dict] = {}
        for doc_id, indices in needs_neighbors.items():
            if not indices:
                continue
            try:
                rows = (
                    table.search()
                    .where(f"doc_id = '{doc_id}'")
                    .to_list()
                )
            except Exception:
                continue
            for row in rows:
                ci = row.get("chunk_index")
                if ci is not None and ci in indices:
                    metadata = {}
                    try:
                        metadata = json.loads(row.get("metadata_json", "{}"))
                    except (json.JSONDecodeError, TypeError):
                        pass
                    neighbor_cache[(doc_id, ci)] = {
                        "chunk_id": row.get("chunk_id", ""),
                        "content": row.get("content", ""),
                        "chunk_index": ci,
                        "page_number": row.get("page_number", 0),
                        "page_start": metadata.get("page_start", row.get("page_number", 0)),
                        "page_end": metadata.get("page_end", row.get("page_number", 0)),
                        "metadata": metadata,
                    }

        # Attach neighbors to each result
        for r in results:
            doc_id = r.get("doc_id", "")
            chunk_idx = r.get("metadata", {}).get("chunk_index")
            if not doc_id or chunk_idx is None:
                r["context"] = {"prev": [], "next": []}
                continue

            prev_chunks = []
            next_chunks = []
            for offset in range(1, context_window + 1):
                prev = neighbor_cache.get((doc_id, chunk_idx - offset))
                if prev:
                    prev_chunks.append(prev)
                nxt = neighbor_cache.get((doc_id, chunk_idx + offset))
                if nxt:
                    next_chunks.append(nxt)
            # prev_chunks are collected closest-first — reverse for document order
            prev_chunks.reverse()

            r["context"] = {"prev": prev_chunks, "next": next_chunks}

        return results

    def get_chunk_by_index(
        self, kb_id: str, doc_id: str, chunk_index: int
    ) -> dict | None:
        """Fetch a single chunk by doc_id + chunk_index.

        Returns the chunk dict with prev_exists / next_exists hints so
        the caller knows whether neighboring chunks are available.
        """
        table = self.get_table(kb_id)
        if table is None:
            return None

        # Get the requested chunk
        try:
            rows = (
                table.search()
                .where(f"doc_id = '{doc_id}' AND chunk_index = {chunk_index}")
                .limit(1)
                .to_list()
            )
        except Exception:
            return None

        if not rows:
            return None

        r = rows[0]
        metadata = {}
        try:
            metadata = json.loads(r.get("metadata_json", "{}"))
        except (json.JSONDecodeError, TypeError):
            pass
        metadata.setdefault("chunk_index", r.get("chunk_index"))
        metadata.setdefault("page", r.get("page_number"))
        if "page_start" not in metadata:
            metadata["page_start"] = r.get("page_number", 0)
        if "page_end" not in metadata:
            metadata["page_end"] = r.get("page_number", 0)
        prev_exists = False
        next_exists = False
        try:
            prev_rows = (
                table.search()
                .where(f"doc_id = '{doc_id}' AND chunk_index = {chunk_index - 1}")
                .limit(1)
                .to_list()
            )
            prev_exists = len(prev_rows) > 0
        except Exception:
            pass
        try:
            next_rows = (
                table.search()
                .where(f"doc_id = '{doc_id}' AND chunk_index = {chunk_index + 1}")
                .limit(1)
                .to_list()
            )
            next_exists = len(next_rows) > 0
        except Exception:
            pass

        ctype = metadata.get("content_type", "text")
        return {
            "chunk_id": r.get("chunk_id", ""),
            "doc_id": r.get("doc_id", ""),
            "kb_id": r.get("kb_id", ""),
            "doc_name": r.get("doc_name", ""),
            "content": r.get("content", ""),
            "chunk_index": r.get("chunk_index"),
            "page_number": r.get("page_number", 0),
            "page_start": metadata.get("page_start", r.get("page_number", 0)),
            "page_end": metadata.get("page_end", r.get("page_number", 0)),
            "content_type": ctype,
            "metadata": metadata,
            "prev_exists": prev_exists,
            "next_exists": next_exists,
        }

    def get_chunk_range(
        self, kb_id: str, doc_id: str, start: int, end: int
    ) -> list[dict]:
        """Fetch all chunks for a document in the given chunk_index range."""
        table = self.get_table(kb_id)
        if table is None:
            return []
        try:
            rows = (
                table.search()
                .where(f"doc_id = '{doc_id}' AND chunk_index >= {start} AND chunk_index <= {end}")
                .limit(end - start + 10)  # slight over-fetch to be safe
                .to_list()
            )
        except Exception:
            return []

        results = []
        for r in rows:
            metadata = {}
            try:
                metadata = json.loads(r.get("metadata_json", "{}"))
            except (json.JSONDecodeError, TypeError):
                pass
            metadata["chunk_index"] = r.get("chunk_index")
            metadata["page"] = r.get("page_number")
            # page_start/page_end are in metadata_json, not separate columns
            if "page_start" not in metadata:
                metadata["page_start"] = r.get("page_number", 0)
            if "page_end" not in metadata:
                metadata["page_end"] = r.get("page_number", 0)
            results.append({
                "chunk_id": r.get("chunk_id", ""),
                "doc_id": r.get("doc_id", ""),
                "kb_id": r.get("kb_id", ""),
                "doc_name": r.get("doc_name", ""),
                "content": r.get("content", ""),
                "chunk_index": r.get("chunk_index"),
                "page_number": r.get("page_number", 0),
                "page_start": metadata.get("page_start", r.get("page_number", 0)),
                "page_end": metadata.get("page_end", r.get("page_number", 0)),
                "start_char": metadata.get("start_char"),
                "metadata": metadata,
            })
        results.sort(key=lambda x: x.get("chunk_index", 0))
        return results

    def get_chunks_by_page(
        self, kb_id: str, doc_id: str, page: int
    ) -> list[dict]:
        """Fetch all chunks whose page range covers the given page number."""
        table = self.get_table(kb_id)
        if table is None:
            return []
        try:
            rows = (
                table.search()
                .where(f"doc_id = '{doc_id}'")
                .limit(10000)
                .to_list()
            )
        except Exception:
            return []

        results = []
        for r in rows:
            metadata = {}
            try:
                metadata = json.loads(r.get("metadata_json", "{}"))
            except (json.JSONDecodeError, TypeError):
                pass
            ps = metadata.get("page_start") or r.get("page_number", 0)
            pe = metadata.get("page_end") or r.get("page_number", 0)
            if ps <= page <= pe:
                metadata["chunk_index"] = r.get("chunk_index")
                metadata["page"] = r.get("page_number")
                results.append({
                    "chunk_id": r.get("chunk_id", ""),
                    "doc_id": r.get("doc_id", ""),
                    "kb_id": r.get("kb_id", ""),
                    "doc_name": r.get("doc_name", ""),
                    "content": r.get("content", ""),
                    "chunk_index": r.get("chunk_index"),
                    "page_number": r.get("page_number", 0),
                    "page_start": ps,
                    "page_end": pe,
                    "start_char": metadata.get("start_char"),
                    "metadata": metadata,
                })
        results.sort(key=lambda x: x.get("chunk_index", 0))
        return results

    def get_kb_stats(self, kb_id: str) -> dict:
        table = self.get_table(kb_id)
        if table is None:
            return {"doc_count": 0, "chunk_count": 0}
        try:
            df = table.to_pandas()
            return {
                "doc_count": int(df["doc_id"].nunique()),
                "chunk_count": int(len(df)),
            }
        except Exception:
            return {"doc_count": 0, "chunk_count": 0}

    def list_kb_ids(self) -> List[str]:
        return [
            name.replace("kb_", "").replace("_", "-")
            for name in self.db.table_names()
        ]

    def close(self):
        self._db = None
