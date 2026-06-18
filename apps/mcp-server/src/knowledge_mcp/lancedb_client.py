"""
LanceDB client for the MCP server.

Provides search, list, and retrieval capabilities directly from LanceDB
without requiring the Python backend service to be running.
"""

import json
from pathlib import Path
from typing import List, Optional

import httpx
import lancedb


class LanceDBSearcher:
    """Lightweight LanceDB search client for MCP tools."""

    def __init__(
        self,
        data_dir: Path,
        embedding_api_base: str,
        embedding_api_key: str,
        embedding_model: str,
        rerank_api_base: str = "",
        rerank_api_key: str = "",
        rerank_model: str = "",
    ):
        self.data_dir = Path(data_dir)
        self.embedding_api_base = embedding_api_base.rstrip("/")
        self.embedding_api_key = embedding_api_key
        self.embedding_model = embedding_model
        self.rerank_api_base = rerank_api_base.rstrip("/")
        self.rerank_api_key = rerank_api_key
        self.rerank_model = rerank_model
        self._db: lancedb.DBConnection | None = None
        self._http = httpx.Client(timeout=30.0)

    @property
    def db(self) -> lancedb.DBConnection:
        if self._db is None:
            self._db = lancedb.connect(str(self.data_dir))
        return self._db

    def _table_name(self, kb_id: str) -> str:
        return f"kb_{kb_id.replace('-', '_')}"

    def _embed(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings via OpenAI-compatible API."""
        if not texts:
            return []
        all_embeddings = []
        for i in range(0, len(texts), 50):
            batch = texts[i : i + 50]
            resp = self._http.post(
                f"{self.embedding_api_base}/v1/embeddings",
                json={"model": self.embedding_model, "input": batch},
                headers={
                    "Authorization": f"Bearer {self.embedding_api_key}",
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            sorted_data = sorted(data["data"], key=lambda x: x["index"])
            all_embeddings.extend([e["embedding"] for e in sorted_data])
        return all_embeddings

    def _rerank(
        self, query: str, documents: List[str], top_n: int
    ) -> List[tuple[int, float]]:
        """Rerank documents. Returns list of (index, score)."""
        if not self.rerank_api_key or not documents:
            return [(i, 1.0) for i in range(min(top_n, len(documents)))]

        try:
            resp = self._http.post(
                f"{self.rerank_api_base}/v1/rerank",
                json={
                    "model": self.rerank_model,
                    "query": query,
                    "documents": documents,
                    "top_n": top_n,
                },
                headers={
                    "Authorization": f"Bearer {self.rerank_api_key}",
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return [
                (r["index"], r.get("relevance_score", 0.0))
                for r in data.get("results", [])[:top_n]
            ]
        except Exception:
            return [(i, 1.0) for i in range(min(top_n, len(documents)))]

    def search(
        self,
        query: str,
        kb_id: str,
        top_k: int = 10,
        search_type: str = "hybrid",
        rerank: bool = True,
        doc_id_filter: Optional[str] = None,
    ) -> List[dict]:
        """Search a knowledge base."""
        if not self.data_dir.exists():
            return []

        table_name = self._table_name(kb_id)
        if table_name not in self.db.table_names():
            return []

        table = self.db.open_table(table_name)

        # Generate query embedding
        query_vector = self._embed([query])[0]

        # Vector search
        fetch_k = top_k * 3 if rerank else top_k
        results = table.search(query_vector).limit(fetch_k)
        if doc_id_filter:
            results = results.where(f"doc_id = '{doc_id_filter}'")
        results = results.limit(fetch_k).to_list()

        # Format results
        formatted = []
        for i, r in enumerate(results):
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
                    "score": float(r.get("_distance", 1.0 - i * 0.05)),
                    "metadata": metadata,
                }
            )

        # Rerank
        if rerank and formatted and self.rerank_api_key:
            documents = [r["content"] for r in formatted]
            reranked = self._rerank(query, documents, top_k)
            new_results = []
            for idx, score in reranked[:top_k]:
                if idx < len(formatted):
                    formatted[idx]["score"] = score
                    new_results.append(formatted[idx])
            formatted = new_results
        else:
            formatted = formatted[:top_k]

        return formatted

    def list_kbs(self) -> List[dict]:
        """List all knowledge bases with stats."""
        if not self.data_dir.exists():
            return []

        kbs = []
        for table_name in self.db.table_names():
            kb_id = table_name.replace("kb_", "").replace("_", "-")
            try:
                table = self.db.open_table(table_name)
                df = table.to_pandas()
                kbs.append(
                    {
                        "id": kb_id,
                        "table_name": table_name,
                        "document_count": int(df["doc_id"].nunique()),
                        "chunk_count": int(len(df)),
                    }
                )
            except Exception:
                kbs.append(
                    {
                        "id": kb_id,
                        "table_name": table_name,
                        "document_count": 0,
                        "chunk_count": 0,
                    }
                )
        return kbs

    def get_document(
        self, kb_id: str, doc_id: str, include_chunks: bool = False
    ) -> dict:
        """Retrieve a document's full content."""
        table_name = self._table_name(kb_id)
        if table_name not in self.db.table_names():
            return {"error": f"Knowledge base not found: {kb_id}"}

        table = self.db.open_table(table_name)
        df = table.to_pandas()
        doc_df = df[df["doc_id"] == doc_id]

        if len(doc_df) == 0:
            return {"error": f"Document not found: {doc_id}"}

        # Reconstruct document from chunks sorted by chunk_index
        sorted_df = doc_df.sort_values("chunk_index")
        full_content = "\n\n".join(sorted_df["content"].tolist())
        doc_name = sorted_df.iloc[0].get("doc_name", doc_id)

        result = {
            "id": doc_id,
            "name": doc_name,
            "content": full_content,
            "chunk_count": int(len(sorted_df)),
        }

        if include_chunks:
            result["chunks"] = [
                {
                    "chunk_id": row["chunk_id"],
                    "chunk_index": int(row["chunk_index"]),
                    "content": row["content"],
                }
                for _, row in sorted_df.iterrows()
            ]

        return result

    def generate_answer(
        self,
        question: str,
        context: str,
        llm_api_base: str,
        llm_api_key: str,
        llm_model: str,
    ) -> str:
        """Generate an answer using the LLM."""
        system_prompt = f"""You are a helpful AI assistant answering questions based on provided knowledge base context.

Context:
{context}

Answer the question based on the context. Include citations to source documents where possible. If the context doesn't contain the answer, say so."""

        resp = self._http.post(
            f"{llm_api_base}/v1/chat/completions",
            json={
                "model": llm_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": question},
                ],
            },
            headers={
                "Authorization": f"Bearer {llm_api_key}",
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]

    def close(self):
        self._http.close()
        self._db = None
