"""Lightweight text chunking for the MCP server.

Recursive text splitter using paragraph → sentence → fixed-size
separators. Similar to the Python backend's RecursiveChunker but
self-contained within the MCP server package.
"""


class ChunkResult:
    """A single chunk produced by the chunker."""

    __slots__ = ("content", "metadata", "chunk_index")

    def __init__(self, content: str, chunk_index: int, **metadata):
        self.content = content
        self.chunk_index = chunk_index
        self.metadata = metadata

    def __repr__(self):
        return f"Chunk(idx={self.chunk_index}, len={len(self.content)})"


class RecursiveChunker:
    """Recursive text splitter using hierarchical separators.

    Separators are tried in order: paragraphs, then sentences
    (Chinese + English), then fixed-size fallback.
    """

    SEPARATORS = ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " ", ""]

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def split(self, text: str, metadata: dict | None = None) -> list[ChunkResult]:
        """Split *text* into chunks, attaching *metadata* to each."""
        meta = dict(metadata or {})
        chunks: list[ChunkResult] = []
        self._split(text, list(self.SEPARATORS), meta, 0, chunks)
        return chunks

    def _split(
        self,
        text: str,
        separators: list[str],
        meta: dict,
        start_idx: int,
        out: list[ChunkResult],
    ) -> int:
        idx = start_idx
        text = text.strip()
        if not text:
            return idx

        # Text fits in one chunk — keep it whole
        if len(text) <= self.chunk_size:
            out.append(ChunkResult(content=text, chunk_index=idx, **meta))
            return idx + 1

        # Try the next separator
        sep = separators.pop(0) if separators else ""

        # No separator left — fixed-size fallback
        if not sep:
            step = max(self.chunk_size - self.chunk_overlap, 1)
            for offset in range(0, len(text), step):
                out.append(
                    ChunkResult(
                        content=text[offset : offset + self.chunk_size].strip(),
                        chunk_index=idx,
                        **meta,
                    )
                )
                idx += 1
            return idx

        # Split on separator, re-merge pieces that fit together
        parts = text.split(sep)
        current = ""
        for part in parts:
            combined = f"{current}{sep}{part}" if current else part
            if len(combined) <= self.chunk_size:
                current = combined
            else:
                if current.strip():
                    idx = self._split(
                        current, list(separators), meta, idx, out
                    )
                current = part

        if current.strip():
            idx = self._split(current, list(separators), meta, idx, out)
        return idx


def chunk_text(
    text: str,
    strategy: str = "recursive",
    chunk_size: int = 512,
    chunk_overlap: int = 50,
    metadata: dict | None = None,
) -> list[ChunkResult]:
    """Convenience: chunk *text* with the given strategy."""
    if strategy == "fixed":
        from .chunker import FixedSizeChunker  # noqa: imported lazily if needed
        raise NotImplementedError("Fixed-size chunker not implemented in MCP server")
    else:
        chunker = RecursiveChunker(chunk_size, chunk_overlap)
    return chunker.split(text, metadata)
