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

    def _vector_search(self, table, query_vector, top_k, doc_id_filter):
        results = table.search(query_vector).limit(top_k * 2)
        if doc_id_filter:
            results = results.where(f"doc_id = '{doc_id_filter}'")
        return self._format_results(results.limit(top_k).to_list(), "vector")

    def _fts_search(self, table, query_text, top_k, doc_id_filter):
        try:
            results = table.search(query_text, query_type="fts").limit(top_k * 2)
            if doc_id_filter:
                results = results.where(f"doc_id = '{doc_id_filter}'")
            return self._format_results(results.limit(top_k).to_list(), "fts")
        except Exception:
            return []

    def _hybrid_search(
        self, table, query_vector, query_text, top_k, doc_id_filter
    ):
        vector_results = self._vector_search(
            table, query_vector, top_k, doc_id_filter
        )
        if query_text:
            fts_results = self._fts_search(table, query_text, top_k, doc_id_filter)
            return self._merge_hybrid_results(vector_results, fts_results, top_k)
        return vector_results

    def _merge_hybrid_results(self, vector_results, fts_results, top_k):
        scores: dict[str, float] = {}
        items: dict[str, dict] = {}

        for r in vector_results:
            cid = r["chunk_id"]
            scores[cid] = r.get("score", 0) * 0.7
            items[cid] = r
        for r in fts_results:
            cid = r["chunk_id"]
            s = r.get("score", 0) * 0.3
            if cid in scores:
                scores[cid] += s
                items[cid]["score"] = scores[cid]
            else:
                scores[cid] = s
                items[cid] = {**r, "score": s}

        merged = sorted(
            items.values(), key=lambda x: x.get("score", 0), reverse=True
        )
        return merged[:top_k]

    def _format_results(self, raw_results: List[dict], source: str) -> List[dict]:
        formatted = []
        for i, r in enumerate(raw_results):
            metadata = {}
            try:
                metadata = json.loads(r.get("metadata_json", "{}"))
            except (json.JSONDecodeError, TypeError):
                pass
            formatted.append(
                {
                    "chunk_id": r.get("chunk_id", ""),
                    "doc_id": r.get("doc_id", ""),
                    "doc_name": r.get("doc_name", ""),
                    "content": r.get("content", ""),
                    "score": r.get("_distance", 1.0 - i * 0.05),
                    "metadata": metadata,
                }
            )
        return formatted

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
