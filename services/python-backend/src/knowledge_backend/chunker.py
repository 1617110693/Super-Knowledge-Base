"""Text chunking strategies for document splitting."""
import re
from dataclasses import dataclass, field
from typing import Dict, Any, List


@dataclass
class Chunk:
    content: str
    metadata: Dict[str, Any]
    chunk_index: int


class Chunker:
    """Base chunker with factory method."""

    @staticmethod
    def create(
        strategy: str, chunk_size: int = 512, chunk_overlap: int = 50
    ) -> "Chunker":
        match strategy:
            case "fixed":
                return FixedSizeChunker(chunk_size, chunk_overlap)
            case "semantic":
                return SemanticChunker(chunk_size, chunk_overlap)
            case "recursive":
                return RecursiveChunker(chunk_size, chunk_overlap)
            case _:
                return RecursiveChunker(chunk_size, chunk_overlap)

    @staticmethod
    def _annotate_char_positions(text: str, chunks: List[Chunk]) -> None:
        """Find each chunk's content in the original text and annotate
        its start_char position.  Copies metadata so chunks don't share dicts."""
        pos = 0
        for c in chunks:
            idx = text.find(c.content, pos)
            c.metadata = dict(c.metadata)  # detach from shared dict
            if idx >= 0:
                c.metadata["start_char"] = idx
                pos = idx + len(c.content)
            else:
                c.metadata["start_char"] = pos

    def chunk(
        self, text: str, metadata: Dict[str, Any] | None = None
    ) -> List[Chunk]:
        raise NotImplementedError


class FixedSizeChunker(Chunker):
    """Split text into fixed-size chunks with overlap."""

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(
        self, text: str, metadata: Dict[str, Any] | None = None
    ) -> List[Chunk]:
        meta = metadata or {}
        chunks = []
        start = 0
        chunk_index = 0
        while start < len(text):
            end = min(start + self.chunk_size, len(text))
            chunks.append(
                Chunk(
                    content=text[start:end],
                    metadata={
                        **meta,
                        "start_char": start,
                        "end_char": end,
                    },
                    chunk_index=chunk_index,
                )
            )
            start += self.chunk_size - self.chunk_overlap
            chunk_index += 1
        return chunks


class SemanticChunker(Chunker):
    """Split text at sentence boundaries, respecting chunk size limit."""

    SENTENCE_PATTERN = re.compile(r"(?<=[.!?。！？\n])\s+")

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(
        self, text: str, metadata: Dict[str, Any] | None = None
    ) -> List[Chunk]:
        meta = metadata or {}
        sentences = self.SENTENCE_PATTERN.split(text)
        sentences = [s.strip() for s in sentences if s.strip()]

        chunks = []
        current = ""
        chunk_index = 0

        for sentence in sentences:
            if len(current) + len(sentence) <= self.chunk_size:
                current = f"{current} {sentence}".strip()
            else:
                if current:
                    chunks.append(
                        Chunk(content=current, metadata=meta, chunk_index=chunk_index)
                    )
                    chunk_index += 1
                if len(sentence) > self.chunk_size:
                    sub = FixedSizeChunker(self.chunk_size, self.chunk_overlap).chunk(
                        sentence, meta
                    )
                    for s in sub:
                        s.chunk_index = chunk_index
                        chunks.append(s)
                        chunk_index += 1
                    current = ""
                else:
                    current = sentence

        if current.strip():
            chunks.append(
                Chunk(content=current.strip(), metadata=meta, chunk_index=chunk_index)
            )
        self._annotate_char_positions(text, chunks)
        return chunks


class RecursiveChunker(Chunker):
    """Recursive text splitter using paragraph → sentence → fixed-size separators."""

    SEPARATORS = ["\n\n", "\n", ". ", "。", "！", "？", "! ", "? ", " ", ""]

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(
        self, text: str, metadata: Dict[str, Any] | None = None
    ) -> List[Chunk]:
        meta = metadata or {}
        chunks: List[Chunk] = []
        self._split_text(text, list(self.SEPARATORS), meta, 0, chunks)
        self._annotate_char_positions(text, chunks)
        return chunks

    def _split_text(
        self,
        text: str,
        separators: List[str],
        meta: Dict[str, Any],
        idx: int,
        chunks: List[Chunk],
    ) -> int:
        if not text.strip():
            return idx
        if len(text) <= self.chunk_size:
            chunks.append(Chunk(content=text.strip(), metadata=meta, chunk_index=idx))
            return idx + 1

        sep = separators.pop(0) if separators else ""
        if not sep:
            for i in range(0, len(text), self.chunk_size - self.chunk_overlap):
                chunks.append(
                    Chunk(
                        content=text[i : i + self.chunk_size].strip(),
                        metadata=meta,
                        chunk_index=idx,
                    )
                )
                idx += 1
            return idx

        splits = text.split(sep)
        current = ""
        for part in splits:
            if len(current) + len(part) + len(sep) <= self.chunk_size:
                current = f"{current}{sep}{part}".strip(sep)
            else:
                if current.strip():
                    idx = self._split_text(
                        current, list(separators), meta, idx, chunks
                    )
                current = part

        if current.strip():
            idx = self._split_text(current, list(separators), meta, idx, chunks)
        return idx
