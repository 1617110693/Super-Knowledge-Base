import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { getDocumentContent, saveDocumentContent, saveDocumentChunks } from "../../services/tauriBridge";
import { indexDocument, getChunkRange, searchDocument } from "../../services/pythonClient";
import { listDocumentImages, readDocumentImage } from "../../services/tauriBridge";
import { useI18n } from "../../i18n";
import { FileText, Loader2, ArrowLeft, Pencil, Check, X, Search, XCircle, ChevronRight, List, ChevronDown, PanelLeftClose, PanelLeft, Image as ImageIcon, LayoutGrid, Rows3 } from "lucide-react";
import { ImageDialog } from "./ImageDialog";
import type { SearchResult } from "../../types";

/** Split into ~3000-char sections */
function splitSections(content: string): string[] {
  const byHeading = content.split(/\n(?=#{1,3}\s)/);
  if (byHeading.length > 1) return byHeading;
  const chunks: string[] = [];
  const paragraphs = content.split(/\n\n+/);
  let cur = "";
  for (const p of paragraphs) {
    if (cur && cur.length + p.length > 3000) { chunks.push(cur); cur = p; }
    else { cur = cur ? cur + "\n\n" + p : p; }
  }
  if (cur) chunks.push(cur);
  return chunks.length > 1 ? chunks : [content];
}

export function DocumentPreview() {
  const { kbId, docId } = useParams<{ kbId: string; docId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [content, setContent] = useState("");
  const [docName, setDocName] = useState("");
  const [loading, setLoading] = useState(true);
  const [startCharMap, setStartCharMap] = useState<Map<number, number>>(new Map());
  const [pageChunksMap, setPageChunksMap] = useState<Map<number, number[]>>(new Map());
  const [hasPageData, setHasPageData] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [pageInput, setPageInput] = useState("");
  const [pageJumpError, setPageJumpError] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  // TOC open state persisted per document
  const [tocOpen, setTocOpen] = useState(() => {
    try { return localStorage.getItem(`skb-toc-${docId}`) === "true"; } catch { return false; }
  });
  const wrappedSetTocOpen = (v: boolean) => {
    setTocOpen(v);
    try { localStorage.setItem(`skb-toc-${docId}`, String(v)); } catch {}
  };

  const [chunkIdx, setChunkIdx] = useState<number | null>(() => {
    const v = new URLSearchParams(window.location.search).get("ci");
    return v ? parseInt(v) : null;
  });
  const [scrollTarget, setScrollTarget] = useState<{ text: string; pos: number } | null>(null);
  const [imageNames, setImageNames] = useState<string[]>([]);
  const [imageSrcs, setImageSrcs] = useState<Map<string, string>>(new Map());
  const [imagesOpen, setImagesOpen] = useState(false);
  const [galleryMode, setGalleryMode] = useState<"grid" | "list">("grid");
  const [dialogIdx, setDialogIdx] = useState<number | null>(null);
  const docScrollRef = useRef<HTMLDivElement>(null);

  // Load document images
  useEffect(() => {
    if (!kbId || !docId) return;
    (async () => {
      try {
        const names = await listDocumentImages(kbId, docId);
        setImageNames(names);
        if (names.length > 0) {
          const srcs = new Map<string, string>();
          for (const name of names.slice(0, 20)) { // limit first load
            try {
              const bytes = await readDocumentImage(kbId, docId, name);
              const blob = new Blob([new Uint8Array(bytes)]);
              srcs.set(name, URL.createObjectURL(blob));
            } catch {}
          }
          setImageSrcs(srcs);
        }
      } catch {}
    })();
  }, [kbId, docId]);

  // Load all thumbnails when images panel opens (not lazy)
  useEffect(() => {
    if (!imagesOpen || !kbId || !docId) return;
    (async () => {
      for (const name of imageNames) {
        if (imageSrcs.has(name)) continue;
        try {
          const bytes = await readDocumentImage(kbId, docId, name);
          const blob = new Blob([new Uint8Array(bytes)]);
          setImageSrcs(prev => { const m = new Map(prev); m.set(name, URL.createObjectURL(blob)); return m; });
        } catch {}
      }
    })();
  }, [imagesOpen, kbId, docId, imageNames]);

  useEffect(() => {
    if (!kbId || !docId) return;
    setLoading(true); setContent(""); setStartCharMap(new Map());
    (async () => {
      try {
        const doc = await getDocumentContent(kbId, docId);
        setDocName(doc.name || doc.id);
        setContent(doc.markdown);
      } catch { setDocName(docId); }
      try {
        const res = await getChunkRange({ kb_id: kbId, doc_id: docId, start: 0, end: 2000 });
        const map = new Map<number, number>();
        const pageMap = new Map<number, number[]>();
        let anyPage = false;
        for (const c of (res.chunks || [])) {
          if (c.start_char != null) map.set(c.chunk_index, c.start_char);
          const ps = c.page_start ?? 0;
          const pe = c.page_end ?? 0;
          if (ps > 0 || pe > 0) anyPage = true;
          for (let p = Math.max(1, ps); p <= Math.max(ps, pe); p++) {
            if (!pageMap.has(p)) pageMap.set(p, []);
            pageMap.get(p)!.push(c.chunk_index);
          }
        }
        setStartCharMap(map);
        setPageChunksMap(pageMap);
        setHasPageData(anyPage);
      } catch {}
      setLoading(false);
    })();
  }, [kbId, docId]);

  const handleStartEdit = () => { setEditContent(content); setEditError(""); setEditing(true); };
  const handleCancelEdit = () => { setEditing(false); setEditContent(""); };

  const jumpToChunk = useCallback((ci: number, heading?: { text: string; pos: number }) => {
    setSearchResults(null);
    window.history.replaceState({}, "", `?ci=${ci}`);
    setScrollTarget(heading || null);
    setChunkIdx(ci);
  }, []);

  const handlePageJump = useCallback(() => {
    const page = Number(pageInput);
    if (!page || page < 1 || !Number.isFinite(page)) return;
    const chunks = pageChunksMap.get(page);
    if (chunks && chunks.length > 0) {
      setPageJumpError("");
      jumpToChunk(chunks[0]);
    } else if (hasPageData) {
      setPageJumpError(t("docs.noChunksOnPage", { page }));
    }
  }, [pageInput, pageChunksMap, hasPageData, t, jumpToChunk]);

  // Build char→chunk/page lookup and extract headings
  const charMaps = useMemo(
    () => buildCharMaps(startCharMap, pageChunksMap),
    [startCharMap, pageChunksMap],
  );
  const headings = useMemo(
    () => (content ? extractHeadings(content, charMaps.findChunk, charMaps.findPage) : []),
    [content, charMaps],
  );
  const maxPage = useMemo(
    () => pageChunksMap.size > 0 ? Math.max(...pageChunksMap.keys()) : 0,
    [pageChunksMap],
  );

  const handleSave = async () => {
    if (!kbId || !docId) return;
    setSaving(true); setEditError("");
    try {
      await saveDocumentContent(kbId, docId, editContent);
      const r = await indexDocument({ kb_id: kbId, doc_id: docId, doc_name: docName, markdown_content: editContent });
      await saveDocumentChunks(kbId, docId, r.chunk_count, r.embedding_model, r.embedding_dim);
      setContent(editContent); setEditing(false);
    } catch (e) { setEditError(String(e)); }
    setSaving(false);
  };

  if (loading || !content) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading document...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <button onClick={() => navigate(`/kb/${kbId}`)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>
      <div className="flex items-center gap-3 mb-6">
        <FileText className="w-6 h-6 text-primary shrink-0" />
        <h2 className="text-xl font-bold truncate">{docName}</h2>
        <div className="flex items-center gap-1 ml-auto">
          {editing ? (
            <>
              <button onClick={handleSave} disabled={saving} className="p-1.5 hover:bg-green-50 rounded-md text-green-600" title={t("docs.save")}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              </button>
              <button onClick={handleCancelEdit} disabled={saving} className="p-1.5 hover:bg-red-50 rounded-md text-red-500" title={t("kb.cancel")}>
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            <button onClick={handleStartEdit} className="p-1.5 hover:bg-muted rounded-md text-muted-foreground" title={t("docs.editMarkdown")}>
              <Pencil className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      {editError && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mb-4">{editError}</div>}
      {editing && <p className="text-xs text-muted-foreground mb-3">{t("docs.editHint")}</p>}

      {/* Document Search + Page Jump Bar */}
      {!editing && (
        <div className="mb-4">
          <div className="flex gap-2">
            {/* Search field */}
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input type="text" value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key !== "Enter" || !kbId || !docId || !searchQuery.trim()) return;
                  setSearching(true); setSearchError(""); setSearchResults(null);
                  try {
                    const r = await searchDocument({ kb_id: kbId, doc_id: docId, query: searchQuery.trim() });
                    setSearchResults(r.results);
                  } catch (err) { setSearchError(String(err)); }
                  setSearching(false);
                }}
                placeholder={t("docs.searchPlaceholder")}
                className="w-full pl-8 pr-8 py-2 text-sm border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary" />
              {searchQuery && (
                <button type="button" onClick={() => { setSearchQuery(""); setSearchResults(null); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <XCircle className="w-4 h-4" />
                </button>
              )}
            </div>
            {/* Search button */}
            <button onClick={async () => {
              if (!kbId || !docId || !searchQuery.trim()) return;
              setSearching(true); setSearchError(""); setSearchResults(null);
              try {
                const r = await searchDocument({ kb_id: kbId, doc_id: docId, query: searchQuery.trim() });
                setSearchResults(r.results);
              } catch (err) { setSearchError(String(err)); }
              setSearching(false);
            }} disabled={searching || !searchQuery.trim()}
              className="px-3 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50">
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : t("search.searchBtn")}
            </button>
          </div>
          {searchError && <p className="text-xs text-red-500 mt-1">{searchError}</p>}
          {pageJumpError && <p className="text-xs text-red-500 mt-1">{pageJumpError}</p>}
          {searchResults && (
            <div className="mt-2 border rounded-lg divide-y max-h-72 overflow-y-auto">
              {searchResults.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground text-center">{t("search.noResults")}</p>
              ) : (
                searchResults.map((r, i) => (
                  <button key={i} onClick={() => {
                    const ci = r.metadata?.chunk_index;
                    if (ci != null) {
                      setSearchResults(null);
                      setSearchQuery("");
                      navigate(`/kb/${kbId}/documents/${docId}?ci=${ci}`);
                    }
                  }}
                  className="block w-full text-left p-3 hover:bg-muted transition-colors">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-mono text-muted-foreground shrink-0">
                        {t("search.chunkLabel", { n: r.metadata?.chunk_index ?? "?" })}{(r.metadata?.page ?? 0) > 0 ? ` · ${t("search.page")} ${r.metadata.page}` : ""}
                      </span>
                      <span className="text-xs font-mono text-primary">{(r.score * 100).toFixed(0)}%</span>
                    </div>
                    <div className="text-xs prose prose-sm max-w-none dark:prose-invert line-clamp-3 [&_p]:my-0 [&_pre]:hidden [&_table]:hidden [&_img]:hidden">
                      <MarkdownRenderer>{r.content.slice(0, 400)}</MarkdownRenderer>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {editing ? (
        <textarea value={editContent} onChange={e => setEditContent(e.target.value)}
          className="w-full min-h-[400px] p-4 border rounded-lg bg-background font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary"
          disabled={saving} />
      ) : (
        <div className="flex gap-3">
          {/* Sidebar column: DocToc handles its own toggle button.
              Image toggle sits below it when both are closed. */}
          <div className="flex flex-col gap-1 shrink-0">
            {/* Image gallery toggle button — only when TOC is closed too */}
            {!imagesOpen && !tocOpen && imageNames.length > 0 && (
              <button onClick={() => setImagesOpen(true)}
                className="p-2 hover:bg-muted rounded-lg text-muted-foreground"
                title={`${imageNames.length} images`}>
                <ImageIcon className="w-4 h-4" />
              </button>
            )}

            {/* Image gallery panel */}
            {imagesOpen && (
              <div className="w-56 border rounded-lg bg-card overflow-hidden flex flex-col max-h-[calc(100vh-200px)]">
              <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50 shrink-0">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Images ({imageNames.length})</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setGalleryMode(galleryMode === "grid" ? "list" : "grid")}
                    className="p-1 hover:bg-muted rounded text-muted-foreground" title="Toggle view">
                    {galleryMode === "grid" ? <Rows3 className="w-3 h-3" /> : <LayoutGrid className="w-3 h-3" />}
                  </button>
                  <button onClick={() => setImagesOpen(false)} className="p-1 hover:bg-muted rounded text-muted-foreground">
                    <PanelLeftClose className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className={`overflow-y-auto flex-1 p-1.5 ${galleryMode === "grid" ? "grid grid-cols-2 gap-1.5" : "space-y-1"}`}>
                {imageNames.map((name, i) => (
                  galleryMode === "grid" ? (
                    <button key={name} onClick={async () => {
                      if (!imageSrcs.has(name)) {
                        try {
                          const bytes = await readDocumentImage(kbId!, docId!, name);
                          const blob = new Blob([new Uint8Array(bytes)]);
                          setImageSrcs(prev => { const m = new Map(prev); m.set(name, URL.createObjectURL(blob)); return m; });
                        } catch {}
                      }
                      setDialogIdx(i);
                    }}
                    className="aspect-square rounded-md overflow-hidden border bg-muted/30 hover:ring-2 ring-primary transition-all">
                      {imageSrcs.has(name)
                        ? <img src={imageSrcs.get(name)} alt={name} className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center text-[10px] text-muted-foreground">Load</div>
                      }
                    </button>
                  ) : (
                    <button key={name} onClick={async () => {
                      if (!imageSrcs.has(name)) {
                        try {
                          const bytes = await readDocumentImage(kbId!, docId!, name);
                          const blob = new Blob([new Uint8Array(bytes)]);
                          setImageSrcs(prev => { const m = new Map(prev); m.set(name, URL.createObjectURL(blob)); return m; });
                        } catch {}
                      }
                      setDialogIdx(i);
                    }}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-muted text-left transition-colors">
                      <div className="w-8 h-8 rounded overflow-hidden border bg-muted/30 shrink-0">
                        {imageSrcs.has(name)
                          ? <img src={imageSrcs.get(name)} alt={name} className="w-full h-full object-cover" />
                          : <div className="w-full h-full flex items-center justify-center"><ImageIcon className="w-3 h-3 text-muted-foreground/50" /></div>
                        }
                      </div>
                      <span className="text-xs truncate flex-1">{name}</span>
                    </button>
                  )
                ))}
              </div>
            </div>
          )}

          {/* TOC panel — hidden when images panel is open */}
          {!imagesOpen && (
          <DocToc
            headings={headings}
            tocOpen={tocOpen}
            setTocOpen={wrappedSetTocOpen}
            jumpToChunk={jumpToChunk}
            hasPageData={hasPageData}
            maxPage={maxPage}
            pageChunksMap={pageChunksMap}
            pageInput={pageInput}
            setPageInput={setPageInput}
            handlePageJump={handlePageJump}
            pageJumpError={pageJumpError}
            t={t}
          />
          )}
          </div>{/* end sidebar column */}
          <div className="flex-1 min-w-0">
            <DocView content={content} startCharMap={startCharMap} chunkIdx={chunkIdx} scrollTarget={scrollTarget} scrollRef={docScrollRef} kbId={kbId} docId={docId} />
          </div>
        </div>
      )}
      {dialogIdx != null && kbId && docId && (
        <ImageDialog
          images={imageNames.map(name => ({ name }))}
          currentIdx={dialogIdx}
          onClose={() => setDialogIdx(null)}
          kbId={kbId} docId={docId}
          onPrev={() => setDialogIdx(i => i != null && i > 0 ? i - 1 : i)}
          onNext={() => setDialogIdx(i => i != null && i < imageNames.length - 1 ? i + 1 : i)}
        />
      )}
    </div>
  );
}

/** Build section byte offsets by finding each section in the original content.
 *  Uses greedy matching: for each section, finds the next occurrence starting from the
 *  previous offset. Falls back to accumulated length estimation if indexOf fails
 *  (which can happen when paragraph split re-joins with \n\n but original had \n\n\n). */
function buildSectionOffsets(content: string, sections: string[]): number[] {
  const offsets: number[] = [];
  let contentPos = 0;
  for (const sec of sections) {
    const idx = content.indexOf(sec, contentPos);
    if (idx >= 0) {
      offsets.push(idx);
      contentPos = idx + sec.length;
    } else {
      // Fallback: estimate position from accumulated length
      offsets.push(contentPos);
      contentPos += sec.length;
    }
  }
  return offsets;
}

/** Return which section contains the given byte position */
function findSectionForChar(sectionOffsets: number[], charPos: number): number {
  for (let i = sectionOffsets.length - 1; i >= 0; i--) {
    if (charPos >= sectionOffsets[i]) return i;
  }
  return 0;
}

// ── TOC ──

interface Heading {
  level: number;
  text: string;
  charOffset: number;
  page?: number;
  chunkIndex?: number;
}

const HEADING_RE = /^(#{1,3})\s+(.+)$/gm;

/** Build (charOffset, chunkIndex) pairs from startCharMap, then a lookup function.
 *  Also returns a page lookup from pageChunksMap. */
function buildCharMaps(
  startCharMap: Map<number, number>,
  pageChunksMap: Map<number, number[]>,
) {
  // char → chunk_index pairs sorted by char offset
  const charChunks: [number, number][] = [];
  for (const [ci, start] of startCharMap) {
    charChunks.push([start, ci]);
  }
  charChunks.sort((a, b) => a[0] - b[0]);

  const findChunk = (pos: number): number | undefined => {
    for (let i = charChunks.length - 1; i >= 0; i--) {
      if (pos >= charChunks[i][0]) return charChunks[i][1];
    }
    return charChunks[0]?.[1];
  };

  // chunk_index → page lookup
  const chunkPage = new Map<number, number>();
  for (const [page, cis] of pageChunksMap) {
    for (const ci of cis) chunkPage.set(ci, page);
  }

  const findPage = (ci: number): number => chunkPage.get(ci) ?? 0;

  return { findChunk, findPage };
}

function extractHeadings(
  content: string,
  findChunk: (pos: number) => number | undefined,
  findPage: (ci: number) => number,
): Heading[] {
  const headings: Heading[] = [];
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(content)) !== null) {
    // Look up the chunk for the heading TEXT position (after "### "),
    // not the `#` character position.  This prevents off-by-one when
    // a chunk boundary falls exactly between the markdown prefix and
    // the heading text.
    const textPos = m.index + m[1].length + 1; // past "### "
    const ci = findChunk(textPos);
    headings.push({
      level: m[1].length,
      text: m[2].trim(),
      charOffset: textPos,
      chunkIndex: ci,
      page: ci != null ? findPage(ci) || undefined : undefined,
    });
  }
  return headings;
}

function DocToc({
  headings, tocOpen, setTocOpen, jumpToChunk, hasPageData, maxPage,
  pageChunksMap, pageInput, setPageInput, handlePageJump, pageJumpError, t,
}: {
  headings: Heading[];
  tocOpen: boolean;
  setTocOpen: (v: boolean) => void;
  jumpToChunk: (ci: number) => void;
  hasPageData: boolean;
  maxPage: number;
  pageChunksMap: Map<number, number[]>;
  pageInput: string; setPageInput: (v: string) => void;
  handlePageJump: () => void;
  pageJumpError: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  if (!tocOpen) {
    return (
      <button onClick={() => setTocOpen(true)}
        className="self-start mt-1 p-2 hover:bg-muted rounded-lg text-muted-foreground shrink-0"
        title={t("docs.tocTitle")}>
        <List className="w-4 h-4" />
      </button>
    );
  }
  // Build linear page list: 1..maxPage
  const pages: number[] = [];
  for (let p = 1; p <= maxPage; p++) pages.push(p);

  return (
    <div className="w-56 shrink-0 border rounded-lg bg-card overflow-hidden flex flex-col max-h-[calc(100vh-200px)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50 shrink-0">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("docs.tocTitle")}</span>
        <button onClick={() => setTocOpen(false)}
          className="p-1 hover:bg-muted rounded text-muted-foreground">
          <PanelLeftClose className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body: headings (left) + linear page bar (right) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Headings column */}
        <div className="flex-1 overflow-y-auto min-w-0 p-1 border-r">
          {headings.length === 0 ? (
            <p className="text-xs text-muted-foreground p-2">{t("docs.tocEmpty")}</p>
          ) : (
            headings.map((h, i) => (
              <button key={i}
                onClick={() => { if (h.chunkIndex != null) jumpToChunk(h.chunkIndex, { text: h.text, pos: h.charOffset }); }}
                className="block w-full text-left px-2 py-1 rounded hover:bg-muted text-xs truncate transition-colors"
                style={{ paddingLeft: `${4 + (h.level - 1) * 10}px` }}>
                {h.text}
              </button>
            ))
          )}
        </div>

        {/* Page bar — linear 1..maxPage, each clickable */}
        {hasPageData && maxPage > 0 && (
          <div className="w-9 shrink-0 overflow-y-auto p-0.5">
            {pages.map((p) => (
              <button key={p}
                onClick={() => {
                  const chunks = pageChunksMap.get(p);
                  if (chunks && chunks.length > 0) jumpToChunk(chunks[0]);
                }}
                className="block w-full text-center py-0.5 text-[10px] tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground rounded transition-colors">
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Page jump at bottom */}
      <div className="border-t p-2 shrink-0">
        <div className="flex gap-1">
          <input type="number" min={1} max={maxPage || 1} value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handlePageJump(); }}
            disabled={!hasPageData}
            placeholder={hasPageData ? t("docs.pageJump") : "-"}
            title={hasPageData ? t("docs.pageJumpHint") : t("docs.noPageData")}
            className="flex-1 px-2 py-1.5 text-xs border rounded bg-background text-center focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-30 disabled:cursor-not-allowed" />
          <button onClick={handlePageJump}
            disabled={!hasPageData || !pageInput}
            title={hasPageData ? t("docs.pageJumpHint") : t("docs.noPageData")}
            className="px-2 py-1.5 text-xs border rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed">
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
        {pageJumpError && <p className="text-[10px] text-red-500 mt-1">{pageJumpError}</p>}
      </div>
    </div>
  );
}

function DocView({ content, startCharMap, chunkIdx, scrollTarget, scrollRef, kbId, docId }: {
  content: string; startCharMap: Map<number, number>; chunkIdx: number | null;
  scrollTarget?: { text: string; pos: number } | null;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  kbId?: string; docId?: string;
}) {
  const sections = useMemo(() => splitSections(content), [content]);
  const sectionOffsets = useMemo(() => buildSectionOffsets(content, sections), [content, sections]);

  // Build sorted chunk entries including char ranges
  const chunkEntries = useMemo(() => {
    const sorted = [...startCharMap.entries()].sort((a, b) => a[0] - b[0]);
    return sorted.map(([idx, start], i) => {
      const end = i + 1 < sorted.length ? sorted[i + 1][1] : content.length;
      return { chunkIndex: idx, startChar: start, endChar: end };
    });
  }, [startCharMap, content]);

  // Map char position → section index (direct, no chunk intermediary)
  const charToSection = useMemo(() => {
    return (pos: number): number => {
      for (let i = sectionOffsets.length - 1; i >= 0; i--) {
        if (pos >= sectionOffsets[i]) return i;
      }
      return 0;
    };
  }, [sectionOffsets]);

  // Map chunk_idx → section_idx
  const chunkSection = useMemo(() => {
    const map = new Map<number, number>();
    for (const e of chunkEntries) {
      map.set(e.chunkIndex, findSectionForChar(sectionOffsets, e.startChar));
    }
    return map;
  }, [chunkEntries, sectionOffsets]);

  const _internalRef = useRef<HTMLDivElement>(null);
  const containerRef = scrollRef ?? _internalRef;
  const obsRef = useRef<IntersectionObserver | null>(null);
  const sentinelsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const highlightRef = useRef<HTMLElement | null>(null);

  const EAGER = 5;

  // Which section contains the target chunk (null if no target)
  const targetSecIdx: number | null = chunkIdx != null ? (chunkSection.get(chunkIdx) ?? null) : null;

  const [rendered, setRendered] = useState<Set<number>>(() => {
    const s = new Set<number>();
    for (let i = 0; i < Math.min(EAGER, sections.length); i++) s.add(i);
    if (targetSecIdx != null) {
      for (let i = Math.max(0, targetSecIdx - 3); i <= Math.min(sections.length - 1, targetSecIdx + 3); i++) s.add(i);
    }
    return s;
  });
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;

  // Ensure target section window is rendered (fires when targetSecIdx changes)
  useEffect(() => {
    if (targetSecIdx == null) return;
    setRendered(prev => {
      const s = new Set(prev);
      for (let i = 0; i < Math.min(EAGER, sections.length); i++) s.add(i);
      for (let i = Math.max(0, targetSecIdx - 3); i <= Math.min(sections.length - 1, targetSecIdx + 3); i++) s.add(i);
      return s;
    });
  }, [targetSecIdx, sections.length]);

  // IntersectionObserver for lazy loading
  useEffect(() => {
    if (obsRef.current) obsRef.current.disconnect();
    obsRef.current = new IntersectionObserver(entries => {
      const next = new Set(renderedRef.current);
      let changed = false;
      for (const e of entries) {
        const idx = Number((e.target as HTMLElement).dataset.sectionIdx);
        if (!isNaN(idx) && e.isIntersecting && !next.has(idx)) {
          next.add(idx); changed = true;
        }
      }
      if (changed) setRendered(next);
    }, { root: containerRef.current, rootMargin: "600px" });
    sentinelsRef.current.forEach(el => obsRef.current?.observe(el));
    return () => obsRef.current?.disconnect();
  }, [sections]);

  const sentinelRef = useCallback((idx: number) => (el: HTMLDivElement | null) => {
    if (el) { sentinelsRef.current.set(idx, el); obsRef.current?.observe(el); }
    else { const old = sentinelsRef.current.get(idx); if (old) obsRef.current?.unobserve(old); sentinelsRef.current.delete(idx); }
  }, []);

  // Scroll to target heading/chunk.  Uses heading char position directly
  // (via charToSection) to find the target section, bypassing the
  // chunk→section mapping which has an off-by-one from chunk boundaries.
  useEffect(() => {
    if (chunkIdx == null) return;

    // Determine target section: prefer heading position if available
    const secIdx = scrollTarget
      ? charToSection(scrollTarget.pos)
      : chunkSection.get(chunkIdx) ?? null;

    // Ensure the target section will be rendered
    if (secIdx != null) {
      setRendered(prev => {
        if (prev.has(secIdx)) return prev;
        const s = new Set(prev);
        for (let i = Math.max(0, secIdx - 3); i <= Math.min(sections.length - 1, secIdx + 3); i++) s.add(i);
        return s;
      });
    }

    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;

      if (highlightRef.current) {
        highlightRef.current.style.backgroundColor = "";
        highlightRef.current = null;
      }

      if (secIdx != null) {
        const sectionEl = container.querySelector(
          `[data-section-idx="${secIdx}"]`
        ) as HTMLElement | null;
        if (sectionEl) {
          // Try to find the heading element within the section
          let targetEl: HTMLElement = sectionEl;
          if (scrollTarget) {
            const stripMd = (s: string) => s.replace(/\s+/g, " ").replace(/[$*_`~]/g, "").trim();
            const want = stripMd(scrollTarget.text);
            const domHeadings = sectionEl.querySelectorAll("h1, h2, h3");
            for (const h of domHeadings) {
              if (stripMd(h.textContent || "") === want) { targetEl = h as HTMLElement; break; }
            }
            if (targetEl === sectionEl) {
              for (const h of domHeadings) {
                const t = stripMd(h.textContent || "");
                if (t && want && (t.includes(want) || want.includes(t))) { targetEl = h as HTMLElement; break; }
              }
            }
          }
          targetEl.scrollIntoView({ block: "start", behavior: "instant" });
          sectionEl.style.backgroundColor = "#fef3c7";
          sectionEl.style.transition = "background-color 0.5s";
          highlightRef.current = sectionEl;
          setTimeout(() => {
            if (highlightRef.current === sectionEl) {
              sectionEl.style.backgroundColor = "";
              highlightRef.current = null;
            }
          }, 2500);
        }
      } else {
        container.scrollTo({ top: 0, behavior: "instant" });
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [chunkIdx, scrollTarget, sections.length, charToSection, chunkSection]);

  // Single section: render with data-section-idx for consistency
  if (sections.length <= 1) {
    return (
      <div ref={containerRef} id="doc-preview-scroll" className="max-h-[calc(100vh-200px)] overflow-y-auto rounded-lg border bg-card prose prose-sm max-w-none dark:prose-invert p-6">
        <div data-section-idx={0}>
          <MarkdownRenderer imgKbId={kbId} imgDocId={docId}>{content}</MarkdownRenderer>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} id="doc-preview-scroll" className="max-h-[calc(100vh-200px)] overflow-y-auto rounded-lg border bg-card">
      <div className="prose prose-sm max-w-none dark:prose-invert p-6">
        {sections.map((sec, i) => {
          if (i < EAGER || rendered.has(i)) {
            return (
              <div key={i} data-section-idx={i} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}>
                <MarkdownRenderer imgKbId={kbId} imgDocId={docId}>{sec}</MarkdownRenderer>
              </div>
            );
          }
          return (
            <div key={i}>
              <div ref={sentinelRef(i)} data-section-idx={i} style={{ height: 1 }} />
              <div style={{ height: 200 }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
