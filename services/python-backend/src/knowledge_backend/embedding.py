"""OpenAI-compatible embedding client."""
import time
from typing import List

import httpx


class OpenAICompatibleEmbedder:
    """Client for OpenAI-compatible embeddings endpoint."""

    def __init__(
        self,
        api_base: str,
        api_key: str,
        model: str,
        dimensions: int | None = None,
    ):
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.dimensions = dimensions
        self._client = httpx.Client(timeout=60.0)
        self._dimension_cache: int | None = None

    def embed(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings for a list of texts."""
        if not texts:
            return []
        all_embeddings = []
        batch_size = 50
        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            embeddings = self._embed_batch(batch)
            all_embeddings.extend(embeddings)
            # Yield GIL so other threads (uvicorn event loop, other daemon
            # threads) can make progress during long indexing runs.
            import time
            time.sleep(0)
        return all_embeddings

    def embed_single(self, text: str) -> List[float]:
        """Generate embedding for a single text."""
        results = self.embed([text])
        return results[0] if results else []

    def _embed_batch(self, texts: List[str]) -> List[List[float]]:
        # llama.cpp with --pooling mean serves OAI-compatible /v1/embeddings
        path = "/v1/embeddings" if self.api_key == "local" else "/embeddings"
        url = f"{self.api_base.rstrip('/')}{path}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body = {"model": self.model, "input": texts}
        if self.dimensions:
            body["dimensions"] = self.dimensions

        for attempt in range(3):
            try:
                resp = self._client.post(url, json=body, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                embeddings = sorted(data["data"], key=lambda x: x["index"])
                return [e["embedding"] for e in embeddings]
            except Exception as e:
                if attempt == 2:
                    raise RuntimeError(f"Embedding request failed: {e}")
                time.sleep(2**attempt)
        return []

    def get_dimension(self) -> int:
        """Return the embedding dimension, detecting it if needed."""
        if self._dimension_cache is not None:
            return self._dimension_cache
        embedding = self.embed_single("Dimension test")
        self._dimension_cache = len(embedding)
        return self._dimension_cache

    def close(self):
        self._client.close()
