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
        results = table.search(query_vector).metric("cosine").limit(top_k * 2)
        if doc_id_filter:
            results = results.where(f"doc_id = '{doc_id_filter}'")
        return self._format_results(results.limit(top_k).to_list(), "vector")

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
            # _distance is a dissimilarity measure (lower = better match).
            # For cosine: range [0, 2] where 0=identical, 2=opposite.
            # Convert to 0–1 similarity: (2.0 - distance) / 2.0
            distance = float(r.get("_distance", 0))
            score = (2.0 - distance) / 2.0
            formatted.append(
                {
                    "chunk_id": r.get("chunk_id", ""),
                    "doc_id": r.get("doc_id", ""),
                    "kb_id": r.get("kb_id", ""),
                    "doc_name": r.get("doc_name", ""),
                    "content": content,
                    "score": score,
                    "metadata": metadata,
                }
            )
        # Post-filter: remove parsing artifact chunks (< 20 meaningful chars like "$$")
        return [r for r in formatted if len(r["content"].strip()) >= 20]

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
