"""Text chunking strategies for document splitting."""
import re
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from .page_mapper import PageMapper


# Regex to detect markdown table separator rows (e.g. |---|---| or |:---|:---:|)
_TABLE_SEP_RE = re.compile(r'^\s*\|[\s\-:|]+\|\s*$', re.MULTILINE)
# Regex to detect a table row (starts and ends with |)
_TABLE_ROW_RE = re.compile(r'^\s*\|.+\|\s*$')
# Regex to detect display math blocks $$...$$
_DISPLAY_MATH_RE = re.compile(r'\$\$[\s\S]*?\$\$', re.MULTILINE)
# Regex to detect inline math $...$ (skip $$)
_INLINE_MATH_RE = re.compile(r'(?<!\$)\$(?!\$)([^$]+?)\$(?!\$)')
# Regex to detect bare LaTeX environments that should be display math
# but are missing $$...$$ delimiters (safety net for chunker edge cases)
_BARE_LATEX_ENVS = (
    "array", "matrix", "pmatrix", "bmatrix", "vmatrix", "Vmatrix",
    "cases", "aligned", "split", "gathered", "equation", "equation*",
)
_BARE_LATEX_RE = re.compile(
    r'(?<!\$\$\n)'                       # not preceded by $$\n (already display math)
    r'\\begin\{(' + '|'.join(_BARE_LATEX_ENVS) + r')\}'
    r'[\s\S]*?'
    r'\\end{\1}'
    r'(?!\n\$\$)',                        # not followed by \n$$ (already display math)
    re.MULTILINE,
)


def _wrap_bare_latex(text: str) -> str:
    """Wrap bare LaTeX environments not inside ``$$...$$`` with display math.

    This is a safety-net called after ``_restore_math`` to catch edge cases
    where the original content_list text carried raw LaTeX without delimiters.
    """
    # Temporarily protect all display math blocks so _BARE_LATEX_RE cannot
    # accidentally match environments that are already inside $$...$$.
    display_store: list[str] = []
    protected = re.sub(r'\$\$[\s\S]*?\$\$', lambda m: (
        display_store.append(m.group(0)) or f"\x00DM{len(display_store)-1}\x00"
    ), text)

    def _replacer(m: re.Match) -> str:
        return f"\n$$\n{m.group(0).strip()}\n$$\n"
    wrapped = _BARE_LATEX_RE.sub(_replacer, protected)

    # Restore protected display math
    for i, orig in enumerate(display_store):
        wrapped = wrapped.replace(f"\x00DM{i}\x00", orig)
    return wrapped


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
    def _protect_math(text: str) -> Tuple[str, Dict[str, str]]:
        """Replace display math blocks ($$...$$) and inline math ($...$) with
        placeholders so chunk boundaries never cut through math content.
        Returns (protected_text, math_map).
        """
        math_map: Dict[str, str] = {}
        counter = 0

        def replace_display(m: re.Match) -> str:
            nonlocal counter
            placeholder = f"{{{{MATH_D_{counter}}}}}"
            math_map[placeholder] = m.group(0)
            counter += 1
            return placeholder

        def replace_inline(m: re.Match) -> str:
            nonlocal counter
            placeholder = f"{{{{MATH_I_{counter}}}}}"
            math_map[placeholder] = m.group(0)
            counter += 1
            return placeholder

        # Protect display math first ($$...$$), then inline math ($...$)
        text = _DISPLAY_MATH_RE.sub(replace_display, text)
        text = _INLINE_MATH_RE.sub(replace_inline, text)
        return text, math_map

    @staticmethod
    def _restore_math(text: str, math_map: Dict[str, str]) -> str:
        """Replace math placeholders with original math content,
        then wrap any bare LaTeX environments that slipped through."""
        for placeholder, original in math_map.items():
            text = text.replace(placeholder, original)
        return _wrap_bare_latex(text)

    @staticmethod
    def _find_table_regions(text: str) -> List[Tuple[int, int]]:
        """Return (start, end) character offsets of all markdown table blocks.

        A table is: header row, separator row, then data rows.  The region
        extends from the beginning of the header row to the end of the last
        consecutive data row.
        """
        regions: List[Tuple[int, int]] = []
        for m in _TABLE_SEP_RE.finditer(text):
            sep_start = m.start()
            sep_end = m.end()
            # Find the header row (line before separator)
            header_start = text.rfind("\n", 0, sep_start - 1)
            header_start = header_start + 1 if header_start >= 0 else 0
            header_line = text[header_start:sep_start].strip()
            if not _TABLE_ROW_RE.match(header_line):
                continue
            # Find all data rows after separator
            # Advance past the newline that follows the separator
            pos = sep_end
            if pos < len(text) and text[pos] == '\n':
                pos += 1
            data_end = sep_end  # fallback: just header+separator
            while pos < len(text):
                nl = text.find("\n", pos)
                if nl < 0:
                    nl = len(text)
                row = text[pos:nl].strip()
                if _TABLE_ROW_RE.match(row):
                    data_end = nl
                    pos = nl + 1 if nl < len(text) else len(text)
                elif row == "":
                    # Empty line ends the table
                    pos = nl + 1 if nl < len(text) else len(text)
                    break
                else:
                    break
            regions.append((header_start, data_end))
        return regions

    @staticmethod
    def _protect_tables(text: str) -> Tuple[str, Dict[str, str]]:
        """Replace markdown tables with placeholders, returning (protected_text, table_map).

        Table placeholders like ``{{TABLE_0}}`` are short tokens that won't
        be split by any chunker.  After chunking, call ``_restore_tables``
        to put the original table content back.
        """
        regions = Chunker._find_table_regions(text)
        if not regions:
            return text, {}

        # Merge overlapping/adjacent regions (shouldn't happen normally)
        merged = []
        for r in sorted(regions):
            if merged and r[0] <= merged[-1][1] + 2:
                merged[-1] = (merged[-1][0], max(merged[-1][1], r[1]))
            else:
                merged.append(r)

        table_map = {}
        parts = []
        prev = 0
        for i, (start, end) in enumerate(merged):
            parts.append(text[prev:start])
            placeholder = f"{{{{TABLE_{i}}}}}"
            parts.append(placeholder)
            table_map[placeholder] = text[start:end]
            prev = end
        parts.append(text[prev:])
        return "".join(parts), table_map

    @staticmethod
    def _restore_tables(chunks: List[Chunk], table_map: Dict[str, str],
                        chunk_size: int = 0) -> List[Chunk]:
        """Replace table placeholders with original table content.

        If a table exceeds *chunk_size* (and chunk_size > 0), the chunk
        is split at the table boundary: text before → separate chunks,
        table split row-by-row with header repetition → multiple chunks,
        text after → separate chunk.  This prevents oversized tables from
        producing a single giant chunk that fails embedding.
        """
        result = []
        for c in chunks:
            restored = c.content
            for placeholder, table_text in table_map.items():
                if placeholder not in restored:
                    continue
                if chunk_size > 0 and len(table_text) > chunk_size:
                    # Split the chunk at the table boundary
                    before, _, after = restored.partition(placeholder)
                    table_parts = Chunker._split_table(table_text, chunk_size)
                    if before.strip():
                        result.append(Chunk(
                            content=before.strip(),
                            metadata=dict(c.metadata),
                            chunk_index=-1,
                        ))
                    for tp in table_parts:
                        result.append(Chunk(
                            content=tp.strip(),
                            metadata=dict(c.metadata),
                            chunk_index=-1,
                        ))
                    restored = after
                else:
                    restored = restored.replace(placeholder, table_text)
            if restored.strip():
                c.content = restored
                result.append(c)
        return result

    @staticmethod
    def _split_table(table_text: str, max_size: int) -> List[str]:
        """Split an oversized markdown table into chunks with header repetition.

        Each chunk gets: header row + separator row + a subset of data rows,
        with each chunk's total size ≤ *max_size*.
        """
        lines = table_text.strip().split("\n")
        if len(lines) < 3:
            return [table_text]  # Not a valid table, return as-is

        header = lines[0]
        separator = lines[1]
        data_rows = lines[2:]
        overhead = len(header) + len(separator) + 2  # +2 for newlines

        parts = []
        current_rows = []
        current_size = overhead

        for row in data_rows:
            row_size = len(row) + 1  # +1 for newline
            if current_rows and current_size + row_size > max_size:
                # Flush current chunk
                parts.append("\n".join([header, separator] + current_rows))
                current_rows = [row]
                current_size = overhead + row_size
            else:
                current_rows.append(row)
                current_size += row_size

        if current_rows:
            parts.append("\n".join([header, separator] + current_rows))

        return parts if parts else [table_text]

    @staticmethod
    def _annotate_char_positions(text: str, chunks: List[Chunk], chunk_overlap: int = 0) -> None:
        """Find each chunk's content in the original text and annotate
        its start_char position.  Copies metadata so chunks don't share dicts."""
        pos = 0
        for c in chunks:
            # Search from current position; if not found (common for overlapping
            # chunks where the overlap starts before pos), retry from the overlap
            # window or the document start.
            idx = text.find(c.content, max(0, pos - chunk_overlap))
            if idx < 0:
                idx = text.find(c.content, 0)
            c.metadata = dict(c.metadata)  # detach from shared dict
            if idx >= 0:
                c.metadata["start_char"] = idx
                pos = idx + len(c.content)
            else:
                c.metadata["start_char"] = pos

    @staticmethod
    def _annotate_page_info(chunks: List[Chunk], page_mapper: "Optional[PageMapper]") -> None:
        """Annotate each chunk with page_start / page_end from the page mapper."""
        if page_mapper is None:
            return
        for c in chunks:
            start_char = c.metadata.get("start_char", 0)
            end_char = start_char + len(c.content)
            page_start, page_end = page_mapper.get_page_range(start_char, end_char)
            c.metadata["page"] = page_start           # backward compat
            c.metadata["page_start"] = page_start
            c.metadata["page_end"] = page_end

    def chunk(
        self, text: str, metadata: Dict[str, Any] | None = None,
        page_mapper: "Optional[PageMapper]" = None,
    ) -> List[Chunk]:
        raise NotImplementedError


class FixedSizeChunker(Chunker):
    """Split text into fixed-size chunks with overlap.

    Markdown tables are protected from being split mid-row by replacing
    them with short placeholders before chunking, then restoring them.
    """

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(
        self, text: str, metadata: Dict[str, Any] | None = None,
        page_mapper: "Optional[PageMapper]" = None,
    ) -> List[Chunk]:
        meta = metadata or {}
        # Protect math blocks first, then tables
        math_protected, math_map = self._protect_math(text)
        protected, table_map = self._protect_tables(math_protected)
        chunks = []
        start = 0
        chunk_index = 0
        while start < len(protected):
            end = min(start + self.chunk_size, len(protected))
            chunks.append(
                Chunk(
                    content=protected[start:end],
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
        chunks = self._restore_tables(chunks, table_map, self.chunk_size)
        # Restore math in each chunk
        for c in chunks:
            c.content = self._restore_math(c.content, math_map)
        self._annotate_char_positions(text, chunks, self.chunk_overlap)
        self._annotate_page_info(chunks, page_mapper)
        return chunks


class SemanticChunker(Chunker):
    """Split text at sentence boundaries, respecting chunk size limit.

    Markdown tables are protected from being split mid-row.
    """

    SENTENCE_PATTERN = re.compile(r"(?<=[.!?。！？\n])\s+")

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(
        self, text: str, metadata: Dict[str, Any] | None = None,
        page_mapper: "Optional[PageMapper]" = None,
    ) -> List[Chunk]:
        meta = metadata or {}
        math_protected, math_map = self._protect_math(text)
        protected, table_map = self._protect_tables(math_protected)
        sentences = self.SENTENCE_PATTERN.split(protected)
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
        chunks = self._restore_tables(chunks, table_map, self.chunk_size)
        for c in chunks:
            c.content = self._restore_math(c.content, math_map)
        self._annotate_char_positions(text, chunks, self.chunk_overlap)
        self._annotate_page_info(chunks, page_mapper)
        return chunks


class RecursiveChunker(Chunker):
    """Recursive text splitter using paragraph → sentence → fixed-size separators.

    Markdown tables are protected from being split mid-row.
    """

    SEPARATORS = ["\n\n", "\n", ". ", "。", "！", "？", "! ", "? ", " ", ""]

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk(
        self, text: str, metadata: Dict[str, Any] | None = None,
        page_mapper: "Optional[PageMapper]" = None,
    ) -> List[Chunk]:
        meta = metadata or {}
        math_protected, math_map = self._protect_math(text)
        protected, table_map = self._protect_tables(math_protected)
        chunks: List[Chunk] = []
        self._split_text(protected, list(self.SEPARATORS), meta, 0, chunks)
        chunks = self._restore_tables(chunks, table_map, self.chunk_size)
        for c in chunks:
            c.content = self._restore_math(c.content, math_map)
        self._annotate_char_positions(text, chunks, self.chunk_overlap)
        self._annotate_page_info(chunks, page_mapper)
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


def multimodal_chunks_from_content_list(
    multimodal_items: list[dict],
    metadata: dict,
    *,
    image_descriptions: dict[str, tuple[str, dict]] | None = None,
) -> list:
    """Generate Chunk objects for image/table/equation items.

    Each chunk gets ``content_type`` in its metadata for search filtering.
    Image descriptions (from VLM) are woven in when available.
    """
    chunks = []
    for i, mi in enumerate(multimodal_items):
        mtype = mi["type"]
        page = mi.get("page_idx", 0)

        if mtype == "image":
            desc_text = ""
            img_name = mi.get("img_path", "").split("/")[-1] or f"image_{i}"
            if image_descriptions and img_name in image_descriptions:
                desc, entity = image_descriptions[img_name]
                desc_text = desc
            content = f"[Image: {img_name}]\n\n{desc_text or mi.get('text', '')}"
            if page:
                content += f"\n\nPage: {page}"

        elif mtype == "table":
            txt = mi.get("text", "")
            content = f"[Table]\n\n{txt}"
            if page:
                content += f"\n\nPage: {page}"

        elif mtype == "equation":
            txt = mi.get("text", "").strip()
            # Ensure LaTeX is wrapped in $$...$$ for proper display rendering
            if txt and not txt.startswith("$$"):
                txt = f"$$\n{txt}\n$$"
            content = f"[Equation]\n\n{txt}"
            if page:
                content += f"\n\nPage: {page}"

        else:
            content = mi.get("text", "")

        chunks.append(Chunk(
            content=content,
            metadata={
                **metadata,
                "content_type": mtype,
                "page": page,
                "page_start": page,
                "page_end": page,
            },
            chunk_index=-1,  # assigned later
        ))
    return chunks
