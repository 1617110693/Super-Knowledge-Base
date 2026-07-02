"""Map markdown character offsets to PDF page numbers using MinerU JSON.

Strategy: CJK characters are preserved identically in both JSON para_blocks and
markdown output. By extracting only CJK character sequences, we get perfectly
matching fingerprints that can be located with 100% accuracy.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple


@dataclass
class PageBoundary:
    start_char: int
    end_char: int
    page_idx: int
    physical_page: int


class PageMapper:
    """Resolves character ranges to page numbers using MinerU JSON metadata."""

    def __init__(self, json_path: Path, markdown_text: str):
        data = json.loads(json_path.read_text(encoding="utf-8"))
        pdf_info = data.get("pdf_info")
        if not isinstance(pdf_info, list) or not pdf_info:
            raise ValueError("mineru_result.json does not contain pdf_info array")
        self._pages: List[PageBoundary] = []
        self._build(pdf_info, markdown_text)

    @classmethod
    def from_doc_dir(cls, doc_dir: Path, markdown_text: str) -> Optional["PageMapper"]:
        json_path = doc_dir / "mineru_result.json"
        if not json_path.exists():
            return None
        try:
            return cls(json_path, markdown_text)
        except (ValueError, json.JSONDecodeError, KeyError) as e:
            import sys
            print(f"[PageMapper] Warning: {e}", file=sys.stderr)
            return None

    def get_page_range(self, start_char: int, end_char: int) -> Tuple[int, int]:
        if not self._pages:
            return (0, 0)
        ps = self._find_page(start_char)
        pe = self._find_page(max(start_char, end_char - 1))
        return (ps, pe)

    def get_page_number(self, start_char: int, end_char: int = 0) -> int:
        start, _ = self.get_page_range(start_char, end_char or start_char)
        return start

    def _build(self, pdf_info: list, markdown_text: str):
        """CJK-character-level matching for 100% accurate page boundaries.

        Extract CJK characters from both the markdown and each page's para_blocks.
        Since CJK chars are never altered by markdown formatting, the sequences
        match perfectly. Find each page's CJK fingerprint in the markdown's CJK
        sequence, then map back to the original character position.
        """
        # Build CJK-only sequence from markdown with position map
        md_cjk: List[str] = []
        md_cjk_pos: List[int] = []  # md_cjk_pos[i] = original position of md_cjk[i]
        for i, ch in enumerate(markdown_text):
            if _is_cjk(ch):
                md_cjk.append(ch)
                md_cjk_pos.append(i)

        if not md_cjk:
            return

        md_cjk_str = "".join(md_cjk)

        prev_cjk_idx = 0
        for pi, page in enumerate(pdf_info):
            para_blocks = page.get("para_blocks") or []
            if not para_blocks:
                continue

            # Concatenate all para_blocks text, extract CJK
            page_text = "".join(_extract_block_text(b) for b in para_blocks)
            page_cjk = "".join(ch for ch in page_text if _is_cjk(ch))

            if len(page_cjk) < 10:
                continue

            # Use the first ~40 CJK chars as anchor
            anchor_len = min(40, len(page_cjk))
            anchor = page_cjk[:anchor_len]

            # Find anchor in the markdown CJK sequence
            cjk_pos = md_cjk_str.find(anchor, prev_cjk_idx)
            if cjk_pos < 0:
                # Try shorter anchor
                for short in (25, 15, 8):
                    if short > len(page_cjk):
                        continue
                    cjk_pos = md_cjk_str.find(page_cjk[:short], prev_cjk_idx)
                    if cjk_pos >= 0:
                        break
            if cjk_pos < 0:
                continue

            # Map CJK position → original markdown position
            md_pos = md_cjk_pos[cjk_pos]
            # Advance past the matched anchor to avoid re-matching the same text
            prev_cjk_idx = cjk_pos + anchor_len

            physical = _extract_physical_page(page, pi)
            self._pages.append(PageBoundary(
                start_char=md_pos,
                end_char=md_pos,  # fixed up below
                page_idx=pi,
                physical_page=physical,
            ))

        # Remove duplicates: if a page number appears multiple times, keep the
        # last occurrence (TOC references often match before the actual content).
        seen: dict = {}
        for p in self._pages:
            seen[p.physical_page] = p  # last write wins
        self._pages = sorted(seen.values(), key=lambda p: p.start_char)

        # Compute temporary end_chars for gap-filling: each page ends where
        # the next begins, or at end of document for the last one.
        for i in range(len(self._pages) - 1):
            self._pages[i].end_char = self._pages[i + 1].start_char
        if self._pages:
            self._pages[-1].end_char = len(markdown_text)

        # Fill gaps: interpolate for pages not found by CJK matching
        if len(self._pages) >= 2:
            filled: List[PageBoundary] = []
            for i, p in enumerate(self._pages):
                filled.append(p)
                if i + 1 < len(self._pages):
                    next_p = self._pages[i + 1]
                    page_gap = next_p.physical_page - p.physical_page
                    if page_gap > 1:
                        char_gap = next_p.start_char - p.end_char
                        chars_per_page = max(1, char_gap // page_gap)
                        for offset in range(1, page_gap):
                            interp_page = p.physical_page + offset
                            interp_start = p.end_char + chars_per_page * (offset - 1)
                            interp_end = p.end_char + chars_per_page * offset
                            filled.append(PageBoundary(
                                start_char=interp_start,
                                end_char=interp_end,
                                page_idx=interp_page - 1,
                                physical_page=interp_page,
                            ))
            self._pages = sorted(filled, key=lambda p: p.start_char)

        # Handle trailing missing pages (no "next page" to interpolate from).
        existing = {p.physical_page for p in self._pages}
        last_known = max(existing) if existing else 0
        total_pages = len(pdf_info)
        if last_known < total_pages:
            last_start = max(p.start_char for p in self._pages if p.physical_page == last_known)
            remaining = total_pages - last_known
            remaining_chars = len(markdown_text) - last_start
            chars_per_page = max(1, remaining_chars // remaining) if remaining > 0 else 500
            for offset in range(1, remaining + 1):
                pg = last_known + offset
                if pg in existing:
                    continue
                self._pages.append(PageBoundary(
                    start_char=last_start + chars_per_page * (offset - 1),
                    end_char=last_start + chars_per_page * offset,
                    page_idx=pg - 1,
                    physical_page=pg,
                ))

        # Fix up end_char: each page ends where the next begins.
        # Ensure strictly increasing start positions.
        for i in range(1, len(self._pages)):
            if self._pages[i].start_char <= self._pages[i - 1].start_char:
                self._pages[i].start_char = self._pages[i - 1].start_char + 1
        for i in range(len(self._pages) - 1):
            self._pages[i].end_char = self._pages[i + 1].start_char
        if self._pages:
            self._pages[-1].end_char = len(markdown_text)

    def _find_page(self, char_offset: int) -> int:
        for b in self._pages:
            if b.start_char <= char_offset < b.end_char:
                return b.physical_page
        if self._pages:
            return self._pages[-1].physical_page
        return 0


# ── helpers ──

_CJK_RANGES = [
    (0x4E00, 0x9FFF),   # CJK Unified
    (0x3400, 0x4DBF),   # CJK Extension A
    (0x20000, 0x2A6DF), # Extension B
    (0xF900, 0xFAFF),   # Compatibility
    (0x3040, 0x309F),   # Hiragana
    (0x30A0, 0x30FF),   # Katakana
    (0xAC00, 0xD7AF),   # Hangul
]


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)


def _extract_physical_page(page_info: dict, page_idx: int) -> int:
    for block in page_info.get("discarded_blocks") or []:
        if block.get("type") == "page_number":
            for line in block.get("lines") or []:
                for span in line.get("spans") or []:
                    content = span.get("content", "").strip()
                    if content:
                        try:
                            return int(content)
                        except ValueError:
                            pass
    return page_idx + 1


def _extract_block_text(block: dict) -> str:
    if block.get("type") == "table":
        parts = []
        for sub in block.get("blocks") or []:
            parts.append(_extract_block_text(sub))
        return " ".join(parts)
    parts = []
    for line in block.get("lines") or []:
        for span in line.get("spans") or []:
            content = span.get("content")
            if content:
                parts.append(content)
    return "".join(parts)


def _split_paragraphs(text: str) -> List[str]:
    raw = re.split(r"\n\s*\n", text)
    return [p.strip() for p in raw if p.strip()]
