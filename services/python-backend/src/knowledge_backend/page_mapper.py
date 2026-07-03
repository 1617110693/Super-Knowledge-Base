"""Map markdown character offsets to PDF page numbers using MinerU JSON.

Two strategies depending on document language:
- CJK mode: fingerprint pages by their CJK character sequence (never altered by markdown)
- Alpha mode: fingerprint by lowercase word sequence (for English/latin documents)

Falls back to paragraph-count alignment if less than 80% of pages are matched.
"""

import json
import os
import re
import sys
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
        self._match_rate = 0.0
        self._build(pdf_info, markdown_text)

    @classmethod
    def from_doc_dir(cls, doc_dir: Path, markdown_text: str) -> Optional["PageMapper"]:
        """Create a PageMapper from a document directory.

        Tries content_list.json first (direct page_idx per block, most
        accurate), falls back to mineru_result.json (fingerprint matching
        against pdf_info).
        """
        # Check cache
        cache_path = doc_dir / "page_map.cache"
        json_path = doc_dir / "mineru_result.json"
        cl_path = doc_dir / "content_list.json"

        # Invalidate cache if either source file is newer
        cl_mtime = cl_path.stat().st_mtime if cl_path.exists() else 0
        json_mtime = json_path.stat().st_mtime if json_path.exists() else 0
        latest_mtime = max(cl_mtime, json_mtime)

        if cache_path.exists() and latest_mtime > 0:
            try:
                cache = json.loads(cache_path.read_text(encoding="utf-8"))
                if cache.get("mtime") == latest_mtime:
                    pm = cls.__new__(cls)
                    pm._pages = [PageBoundary(**p) for p in cache["pages"]]
                    pm._match_rate = cache.get("match_rate", 0)
                    return pm
            except Exception:
                pass

        if not json_path.exists() and not cl_path.exists():
            return None

        pm = None
        try:
            if cl_path.exists():
                pm = cls._from_content_list(cl_path, json_path, markdown_text)
            if pm is None and json_path.exists():
                pm = cls(json_path, markdown_text)
        except (ValueError, json.JSONDecodeError, KeyError) as e:
            print(f"[PageMapper] Warning: {e}", file=sys.stderr)

        if pm is None:
            return None

        # Write cache
        try:
            cache = {
                "mtime": latest_mtime,
                "match_rate": pm._match_rate,
                "pages": [{"start_char": p.start_char, "end_char": p.end_char,
                           "page_idx": p.page_idx, "physical_page": p.physical_page}
                          for p in pm._pages],
            }
            cache_path.write_text(json.dumps(cache), encoding="utf-8")
        except Exception:
            pass
        return pm

    @classmethod
    def _from_content_list(
        cls, cl_path: Path, layout_path: Path, markdown_text: str
    ) -> Optional["PageMapper"]:
        """Build page mapper from content_list.json + mineru_result.json.

        Matches every individual block (not whole pages) against the markdown.
        Each block's short, unique text is much easier to locate than a whole
        page worth of text — this gives near-100% match rates.
        """
        cl_data = json.loads(cl_path.read_text(encoding="utf-8"))
        if not isinstance(cl_data, list):
            return None

        # Load printed page number mapping from layout.json
        page_num_map: dict = {}  # page_idx → printed page number
        if layout_path.exists():
            try:
                layout = json.loads(layout_path.read_text(encoding="utf-8"))
                pdf_info = layout.get("pdf_info") or []
                for pi, page in enumerate(pdf_info):
                    page_num_map[pi] = _extract_physical_page(page, pi)
            except Exception:
                pass

        # Build ordered list of (page_idx, block_text) for all blocks
        blocks: list = []  # [(page_idx, text), ...]
        for item in cl_data:
            if not isinstance(item, dict):
                continue
            pi = item.get("page_idx")
            if not isinstance(pi, int):
                continue
            if item.get("type") == "page_number":
                continue
            text = _extract_content_list_text(item)
            if text:
                blocks.append((pi, text))

        if not blocks:
            return None

        # Count unique pages
        total_pages = len({b[0] for b in blocks})

        # Choose mode
        cjk_count = sum(1 for ch in markdown_text if _is_cjk(ch))
        cjk_density = cjk_count / max(1, len(markdown_text))
        mode = "cjk" if cjk_density > 0.05 else "alpha"

        # Build token index for markdown
        if mode == "cjk":
            md_tokens, md_tok_pos = _cjks_with_pos(markdown_text)
            md_tok_str = "".join(md_tokens)
            get_fp = lambda text: "".join(ch for ch in text if _is_cjk(ch))
            min_fp_len = 5
        else:
            md_tokens, md_tok_pos = _words_with_pos(markdown_text)
            md_tok_str = " ".join(md_tokens)
            get_fp = lambda text: " ".join(_extract_words(text))
            min_fp_len = 3

        # Block-level matching: walk through blocks in order, match each
        # individually. Since blocks appear in markdown in the same order as
        # content_list, we search forward from the last found position.
        prev_tok = 0
        hits: dict = {}  # page_idx → [md_char_positions]
        matched_count = 0
        total_text_blocks = 0

        for page_idx, block_text in blocks:
            fp = get_fp(block_text)
            if mode == "cjk":
                if len(fp) < min_fp_len:
                    continue
                total_text_blocks += 1
                pos = md_tok_str.find(fp, prev_tok)
                if pos < 0:
                    # Try shorter prefix — block may have minor text differences
                    pos = md_tok_str.find(fp[:max(8, len(fp) // 2)], prev_tok)
            else:
                words = fp.split()
                if len(words) < min_fp_len:
                    continue
                total_text_blocks += 1
                anchor = " ".join(words[:8])
                pos = md_tok_str.find(anchor, prev_tok)
                if pos < 0:
                    pos = md_tok_str.find(" ".join(words[:max(3, len(words) // 2)]), prev_tok)

            if pos < 0:
                continue

            matched_count += 1
            md_pos = md_tok_pos[pos] if pos < len(md_tok_pos) else 0
            hits.setdefault(page_idx, []).append(md_pos)
            prev_tok = pos + 1  # advance past this match

        block_match_rate = matched_count / max(1, total_text_blocks)

        if block_match_rate < 0.5 and total_text_blocks > 20:
            print(
                f"[PageMapper] Block match rate {block_match_rate:.0%} too low, "
                f"falling back to layout.json",
                file=sys.stderr,
            )
            return None

        # Build page boundaries from block hits.
        # Each page's start_char = min position of its blocks;
        # end_char is set later by _fixup_boundaries.
        boundaries = []
        for page_idx, positions in sorted(hits.items()):
            physical = page_num_map.get(page_idx, page_idx + 1)
            boundaries.append(PageBoundary(
                start_char=min(positions),
                end_char=max(positions),  # temporary, fixed by _fixup_boundaries
                page_idx=page_idx,
                physical_page=physical,
            ))
        boundaries.sort(key=lambda p: p.start_char)

        # Build PageMapper instance
        pm = cls.__new__(cls)
        pm._pages = boundaries
        pm._match_rate = block_match_rate

        # Fill missing pages via interpolation
        pm._interpolate_remaining(total_pages, len(markdown_text))
        pm._fixup_boundaries(len(markdown_text))

        print(
            f"[PageMapper] block-level: {matched_count}/{total_text_blocks} blocks matched "
            f"({block_match_rate:.0%}), {len(boundaries)}/{total_pages} pages",
            file=sys.stderr,
        )
        return pm

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
        """Detect language mode, fingerprint pages, fill gaps, verify quality."""
        total_pages = len(pdf_info)
        # Auto-detect mode: if >20% of chars are CJK, use CJK mode
        cjk_count = sum(1 for ch in markdown_text if _is_cjk(ch))
        cjk_density = cjk_count / max(1, len(markdown_text))
        use_cjk = cjk_density > 0.05  # 5% threshold is enough for reliable CJK matching

        mode = "cjk" if use_cjk else "alpha"
        matched, unmatched = self._match_pages(pdf_info, markdown_text, mode)

        self._match_rate = len(matched) / total_pages if total_pages > 0 else 0

        # Quality check: if <80% matched, fall back to paragraph-count
        if self._match_rate < 0.8 and total_pages > 10:
            print(f"[PageMapper] Low match rate ({self._match_rate:.0%}) with {mode} mode, "
                  f"falling back to paragraph-count alignment", file=sys.stderr)
            self._pages = self._fallback_paragraph_count(pdf_info, markdown_text)
            return

        self._pages = matched

        # Fill gaps: iterative search within adjacent page boundaries
        self._fill_gaps(pdf_info, markdown_text, mode)

        # Final interpolation for remaining gaps
        self._interpolate_remaining(total_pages, len(markdown_text))

        # Fix up end_char chain
        self._fixup_boundaries(len(markdown_text))

        # Log summary
        final_count = len({p.physical_page for p in self._pages})
        interpolated = final_count - len({p.physical_page for p in matched})
        if interpolated > 0 or unmatched:
            print(f"[PageMapper] {mode} mode: {len(matched)}/{total_pages} matched, "
                  f"{interpolated} interpolated, {len(unmatched)} gaps",
                  file=sys.stderr)

    def _match_pages(self, pdf_info: list, markdown_text: str, mode: str
                     ) -> Tuple[List[PageBoundary], List[int]]:
        """Fingerprint each page and find it in the markdown.

        Returns (matched_boundaries, unmatched_page_indices).
        """
        if mode == "cjk":
            tokens, tok_pos = _cjks_with_pos(markdown_text)
            tok_str = "".join(tokens)
            get_fingerprint = lambda text: "".join(ch for ch in text if _is_cjk(ch))
            min_len = 8
            anchor_len = 40
        else:
            tokens, tok_pos = _words_with_pos(markdown_text)
            tok_str = " ".join(tokens)
            get_fingerprint = lambda text: " ".join(_extract_words(text))
            min_len = 5
            anchor_len = 20

        prev_idx = 0
        matched: List[PageBoundary] = []
        unmatched: List[int] = []

        for pi, page in enumerate(pdf_info):
            para_blocks = page.get("para_blocks") or []
            if not para_blocks:
                unmatched.append(pi)
                continue

            page_text = "".join(_extract_block_text(b) for b in para_blocks)
            fp = get_fingerprint(page_text)

            if mode == "cjk":
                if len(fp) < min_len:
                    unmatched.append(pi)
                    continue
                anchor = fp[:anchor_len]
                pos = tok_str.find(anchor, prev_idx)
                if pos < 0:
                    for short in (25, 15, 8):
                        if short > len(fp): continue
                        pos = tok_str.find(fp[:short], prev_idx)
                        if pos >= 0: break
            else:
                # Alpha mode: use word-level matching
                if len(fp.split()) < min_len:
                    unmatched.append(pi)
                    continue
                anchor = " ".join(fp.split()[:anchor_len])
                pos = tok_str.find(anchor, prev_idx)
                if pos < 0:
                    for short in (12, 8, 5):
                        words = fp.split()[:short]
                        if len(words) < 3: continue
                        pos = tok_str.find(" ".join(words), prev_idx)
                        if pos >= 0: break

            if pos < 0:
                unmatched.append(pi)
                continue

            md_pos = tok_pos[pos] if pos < len(tok_pos) else 0
            prev_idx = pos + len(anchor)
            physical = _extract_physical_page(page, pi)
            matched.append(PageBoundary(
                start_char=md_pos, end_char=md_pos,
                page_idx=pi, physical_page=physical,
            ))

        # Dedup: for the first page, keep the FIRST match (it starts at the
        # beginning of the document).  For all other pages, keep the LAST
        # match (TOC references are matched before actual content).
        seen: dict = {}
        first_page_num = _extract_physical_page(pdf_info[0], 0)
        for p in matched:
            if p.physical_page == first_page_num:
                if first_page_num not in seen:
                    seen[first_page_num] = p  # first write wins
            else:
                seen[p.physical_page] = p  # last write wins for others
        return sorted(seen.values(), key=lambda p: p.start_char), unmatched

    def _fill_gaps(self, pdf_info: list, markdown_text: str, mode: str):
        """Iteratively search for unmatched pages within adjacent boundaries."""
        if len(self._pages) < 2:
            return

        if mode == "cjk":
            md_tokens, md_tok_pos = _cjks_with_pos(markdown_text)
            md_tok_str = "".join(md_tokens)
            get_fp = lambda text: "".join(ch for ch in text if _is_cjk(ch))
        else:
            md_tokens, md_tok_pos = _words_with_pos(markdown_text)
            md_tok_str = " ".join(md_tokens)
            get_fp = lambda text: " ".join(_extract_words(text))

        new_pages = list(self._pages)
        added = True
        max_iter = min(len(pdf_info) * 2, 20)  # cap at 20 passes for performance
        iters = 0
        while added and iters < max_iter:
            added = False
            iters += 1
            new_pages.sort(key=lambda p: p.start_char)
            for i in range(len(new_pages) - 1):
                p = new_pages[i]
                next_p = new_pages[i + 1]
                page_gap = next_p.physical_page - p.physical_page
                if page_gap <= 1:
                    continue
                for offset in range(1, page_gap):
                    target_page = p.physical_page + offset
                    if target_page >= len(pdf_info):
                        continue
                    tj = pdf_info[target_page]
                    blocks = tj.get("para_blocks") or []
                    if not blocks:
                        continue
                    text = "".join(_extract_block_text(b) for b in blocks)
                    fp = get_fp(text)

                    if mode == "cjk":
                        if len(fp) < 8: continue
                        anchor = fp[:35]
                    else:
                        words = fp.split()
                        if len(words) < 5: continue
                        anchor = " ".join(words[:15])

                    # Compute token indices for gap
                    gap_start = 0
                    for ti, tpos in enumerate(md_tok_pos):
                        if tpos >= p.end_char: gap_start = ti; break
                    gap_end = len(md_tok_str)
                    for ti, tpos in enumerate(md_tok_pos):
                        if tpos >= next_p.start_char: gap_end = ti; break

                    pos = md_tok_str.find(anchor, gap_start, gap_end)
                    if pos < 0:
                        for short_len in (20, 12, 8) if mode == "cjk" else (10, 6, 4):
                            short = anchor[:short_len] if mode == "cjk" else " ".join(anchor.split()[:short_len])
                            if len(short) < 3: continue
                            pos = md_tok_str.find(short, gap_start, gap_end)
                            if pos >= 0: break
                    if pos >= 0:
                        md_pos = md_tok_pos[pos] if pos < len(md_tok_pos) else 0
                        phys = _extract_physical_page(tj, target_page)
                        new_pages.append(PageBoundary(
                            start_char=md_pos, end_char=md_pos,
                            page_idx=target_page, physical_page=phys,
                        ))
                        added = True
                        break
                if added:
                    break

        seen2 = {}
        for p in sorted(new_pages, key=lambda p: p.start_char):
            seen2[p.physical_page] = p
        self._pages = sorted(seen2.values(), key=lambda p: p.start_char)

    def _interpolate_remaining(self, total_pages: int, md_len: int):
        """Interpolate any remaining gaps between adjacent pages."""
        if not self._pages:
            return
        self._pages.sort(key=lambda p: p.start_char)

        # Handle leading pages (before first matched page)
        first_phys = self._pages[0].physical_page
        if first_phys > 1:
            leading_gap = first_phys - 1
            first_start = self._pages[0].start_char
            cpp = max(1, first_start // leading_gap) if leading_gap > 0 else 1
            for off in range(1, leading_gap + 1):
                pg = first_phys - leading_gap + off - 1
                self._pages.append(PageBoundary(
                    start_char=cpp * (off - 1),
                    end_char=cpp * off,
                    page_idx=pg - 1, physical_page=pg,
                ))

        # Temp end_chars
        for i in range(len(self._pages) - 1):
            self._pages[i].end_char = self._pages[i + 1].start_char
        self._pages[-1].end_char = md_len

        filled: List[PageBoundary] = []
        for i, p in enumerate(self._pages):
            filled.append(p)
            if i + 1 < len(self._pages):
                next_p = self._pages[i + 1]
                gap = next_p.physical_page - p.physical_page
                if gap > 1:
                    char_gap = next_p.start_char - p.end_char
                    cpp = max(1, char_gap // gap)
                    for off in range(1, gap):
                        pg = p.physical_page + off
                        filled.append(PageBoundary(
                            start_char=p.end_char + cpp * (off - 1),
                            end_char=p.end_char + cpp * off,
                            page_idx=pg - 1, physical_page=pg,
                        ))

        seen3 = {}
        for p in filled:
            seen3[p.physical_page] = p
        self._pages = sorted(seen3.values(), key=lambda p: p.start_char)

        # Handle trailing pages
        existing = {p.physical_page for p in self._pages}
        last_known = max(existing) if existing else 0
        if last_known < total_pages:
            last_start = max(p.start_char for p in self._pages if p.physical_page == last_known)
            remaining = total_pages - last_known
            rem_chars = md_len - last_start
            cpp = max(1, rem_chars // remaining) if remaining > 0 else 500
            for off in range(1, remaining + 1):
                pg = last_known + off
                if pg in existing: continue
                self._pages.append(PageBoundary(
                    start_char=last_start + cpp * (off - 1),
                    end_char=last_start + cpp * off,
                    page_idx=pg - 1, physical_page=pg,
                ))

    def _fixup_boundaries(self, md_len: int):
        self._pages.sort(key=lambda p: p.start_char)
        # First page must start at position 0
        if self._pages and self._pages[0].start_char > 0:
            self._pages[0].start_char = 0
        for i in range(1, len(self._pages)):
            if self._pages[i].start_char <= self._pages[i - 1].start_char:
                self._pages[i].start_char = self._pages[i - 1].start_char + 1
        for i in range(len(self._pages) - 1):
            self._pages[i].end_char = self._pages[i + 1].start_char
        if self._pages:
            self._pages[-1].end_char = md_len

    def _fallback_paragraph_count(self, pdf_info: list, markdown_text: str
                                  ) -> List[PageBoundary]:
        """Simple paragraph-count alignment as last resort."""
        md_paras = _split_paragraphs(markdown_text)
        pages: List[PageBoundary] = []
        para_idx = 0
        char_off = 0
        for pi, page in enumerate(pdf_info):
            count = len(page.get("para_blocks") or [])
            if count == 0: continue
            start = char_off
            end_p = min(para_idx + count, len(md_paras))
            for p in md_paras[para_idx:end_p]:
                char_off += len(p) + 2
            para_idx = end_p
            phys = _extract_physical_page(page, pi)
            pages.append(PageBoundary(start, char_off, pi, phys))
        return pages

    def _find_page(self, char_offset: int) -> int:
        for b in self._pages:
            if b.start_char <= char_offset < b.end_char:
                return b.physical_page
        if self._pages:
            # Before first page → use first page; after last page → use last page
            if char_offset < self._pages[0].start_char:
                return self._pages[0].physical_page
            return self._pages[-1].physical_page
        return 0


# ── helpers ──

_CJK_RANGES = [
    (0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0x20000, 0x2A6DF),
    (0xF900, 0xFAFF), (0x3040, 0x309F), (0x30A0, 0x30FF), (0xAC00, 0xD7AF),
]


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)


def _is_alpha(ch: str) -> bool:
    return ch.isalpha() and ch.isascii()


def _cjks_with_pos(text: str) -> Tuple[List[str], List[int]]:
    chars, pos = [], []
    for i, ch in enumerate(text):
        if _is_cjk(ch):
            chars.append(ch)
            pos.append(i)
    return chars, pos


def _words_with_pos(text: str) -> Tuple[List[str], List[int]]:
    words, pos = [], []
    for m in re.finditer(r'[a-zA-Z]{2,}', text):
        words.append(m.group().lower())
        pos.append(m.start())
    return words, pos


def _extract_words(text: str) -> List[str]:
    return [w.lower() for w in re.findall(r'[a-zA-Z]{2,}', text)]


def _extract_physical_page(page_info: dict, page_idx: int) -> int:
    for block in page_info.get("discarded_blocks") or []:
        if block.get("type") == "page_number":
            for line in block.get("lines") or []:
                for span in line.get("spans") or []:
                    content = span.get("content", "").strip()
                    if content:
                        try: return int(content)
                        except ValueError: pass
    return page_idx + 1


def _extract_block_text(block: dict) -> str:
    if block.get("type") == "table":
        return " ".join(_extract_block_text(s) for s in (block.get("blocks") or []))
    return "".join(
        span.get("content", "")
        for line in (block.get("lines") or [])
        for span in (line.get("spans") or [])
        if span.get("content")
    )


def _extract_content_list_text(item: dict) -> str:
    """Extract text content from a content_list.json item.

    Different item types store text in different fields.  Returns the
    concatenated text suitable for fingerprint matching.
    """
    parts = []
    item_type = str(item.get("type") or "").lower()

    # Primary text field
    for key in ("text", "content", "body"):
        val = item.get(key)
        if isinstance(val, str) and val.strip():
            parts.append(val.strip())

    # Type-specific text
    if item_type == "list":
        items = item.get("list_items")
        if isinstance(items, list):
            parts.extend(str(x).strip() for x in items if str(x).strip())

    if item_type == "code":
        code = item.get("code_body") or item.get("content") or ""
        if isinstance(code, str) and code.strip():
            parts.append(code.strip())

    if item_type in ("image", "picture"):
        for key in ("image_caption", "image_footnote", "img_caption", "img_footnote"):
            val = item.get(key)
            if isinstance(val, str) and val.strip():
                parts.append(val.strip())

    if item_type == "table":
        for key in ("table_caption", "table_footnote"):
            val = item.get(key)
            if isinstance(val, str) and val.strip():
                parts.append(val.strip())
        # MinerU outputs tables in multiple formats — HTML string,
        # JSON grid (list of lists), or dict with "grid"/"rows" key.
        # Extract text content regardless of format for fingerprint quality.
        body = item.get("table_body") or item.get("rows")
        if isinstance(body, str) and body.strip():
            if body.strip().startswith("<"):
                # HTML table — strip tags for text fingerprint
                parts.append(_strip_html(body))
            else:
                parts.append(body.strip())
        elif isinstance(body, list):
            # Grid — flatten to text
            for row in body:
                if isinstance(row, (list, tuple)):
                    parts.extend(str(c) for c in row if str(c).strip())
                elif isinstance(row, str):
                    parts.append(row.strip())
        elif isinstance(body, dict):
            grid = body.get("grid") or body.get("rows")
            if isinstance(grid, list):
                for row in grid:
                    if isinstance(row, (list, tuple)):
                        parts.extend(str(c) for c in row if str(c).strip())
                    elif isinstance(row, str):
                        parts.append(row.strip())

    if item_type == "equation":
        latex = item.get("latex") or item.get("text") or ""
        if isinstance(latex, str) and latex.strip():
            parts.append(latex.strip())

    return " ".join(parts)


_STRIP_HTML_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    """Remove HTML tags and decode common entities, returning plain text."""
    text = _STRIP_HTML_RE.sub(" ", html)
    # Decode common HTML entities
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ")
    return " ".join(text.split())


def extract_multimodal_items(content_list: list) -> list[dict]:
    """Extract image, table, and equation items from a content_list.json.

    Returns a list of dicts with keys:
    - type: "image" | "table" | "equation"
    - item: the original content_list item
    - text: plain-text representation (table body, latex, etc.)
    - page_idx: 0-based page index
    """
    items: list[dict] = []
    for item in content_list:
        if not isinstance(item, dict):
            continue
        itype = str(item.get("type") or "").lower()
        page_idx = item.get("page_idx")
        if not isinstance(page_idx, int):
            continue

        # image, picture, chart are all visual content — treat as images
        if itype in ("image", "picture", "chart"):
            caption = ""
            for key in ("image_caption", "img_caption", "chart_caption"):
                val = item.get(key)
                if isinstance(val, list):
                    caption = "; ".join(str(v) for v in val if str(v).strip())
                elif isinstance(val, str) and val.strip():
                    caption = val
            img_path = str(item.get("img_path") or "")
            items.append({
                "type": "image",
                "item": item,
                "text": caption,
                "page_idx": page_idx,
                "img_path": img_path,
            })

        elif itype == "table":
            caption = ""
            for key in ("table_caption",):
                val = item.get(key)
                if isinstance(val, list):
                    caption = "; ".join(str(v) for v in val if str(v).strip())
                elif isinstance(val, str) and val.strip():
                    caption = val
            body = item.get("table_body") or item.get("rows") or ""
            if isinstance(body, list):
                # Render grid to markdown table
                rows = [str(c) for row in body for c in (row if isinstance(row, (list, tuple)) else [row])]
                body_text = " | ".join(rows)
            elif isinstance(body, str):
                body_text = _strip_html(body) if body.strip().startswith("<") else body
            else:
                body_text = str(body)
            items.append({
                "type": "table",
                "item": item,
                "text": f"{caption}\n{body_text}".strip(),
                "page_idx": page_idx,
            })

        elif itype == "equation":
            latex = item.get("latex") or item.get("text") or ""
            items.append({
                "type": "equation",
                "item": item,
                "text": latex.strip() if isinstance(latex, str) else str(latex),
                "page_idx": page_idx,
            })

    return items


def _split_paragraphs(text: str) -> List[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
