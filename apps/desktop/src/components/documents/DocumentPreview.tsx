import { useEffect, useState, useMemo, useRef, useCallback, startTransition, memo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { getDocumentContent, saveDocumentContent, saveDocumentChunks } from "../../services/tauriBridge";
import { indexDocument, waitForIndex, getChunkRange, searchDocument } from "../../services/pythonClient";
import { listDocumentImages, readDocumentImage } from "../../services/tauriBridge";
import { useI18n } from "../../i18n";
import { useTabStore, entriesToMap, mapToEntries, isCacheStale } from "../../stores/useTabStore";
import { FileText, Loader2, ArrowLeft, Pencil, Check, X, Search, XCircle, ChevronRight, List, ChevronDown, PanelLeftClose, PanelLeft, Image as ImageIcon, LayoutGrid, Rows3, AlertTriangle, RefreshCw, Settings } from "lucide-react";
import { ImageDialog } from "./ImageDialog";
import type { SearchResult } from "../../types";

/** Convert a positive integer to lowercase Roman numerals. */
function toRoman(n: number): string {
  if (n <= 0) return String(n);
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ["m", "cm", "d", "cd", "c", "xc", "l", "xl", "x", "ix", "v", "iv", "i"];
  let r = "";
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { r += syms[i]; n -= vals[i]; }
  }
  return r;
}

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeHeadingText, setActiveHeadingText] = useState<string | null>(null);

  // TOC open state persisted per document
  const [tocOpen, setTocOpen] = useState(() => {
    try { return localStorage.getItem(`skb-toc-${docId}`) === "true"; } catch { return false; }
  });
  const wrappedSetTocOpen = (v: boolean) => {
    startTransition(() => setTocOpen(v));
    try { localStorage.setItem(`skb-toc-${docId}`, String(v)); } catch {}
  };

  const [mdAvailable, setMdAvailable] = useState(true);
  const [chunkIdx, setChunkIdx] = useState<number | null>(() => {
    const v = new URLSearchParams(window.location.search).get("ci");
    return v ? parseInt(v) : null;
  });
  const [scrollTarget, setScrollTarget] = useState<{ text: string; pos: number; n: number } | null>(null);
  const [jumpTrigger, setJumpTrigger] = useState(0);
  const jumpCounter = useRef(0);
  const [imageNames, setImageNames] = useState<string[]>([]);
  const [imageSrcs, setImageSrcs] = useState<Map<string, string>>(new Map());
  const [imagesOpen, setImagesOpen] = useState(false);
  const [galleryMode, setGalleryMode] = useState<"grid" | "list">("grid");
  const [dialogIdx, setDialogIdx] = useState<number | null>(null);
  const [fillTaskId, setFillTaskId] = useState<string | null>(null);
  const [fillProgress, setFillProgress] = useState<{ current: number; total: number; currentName: string; message: string; done: boolean; filled?: number; failed?: number; failed_details?: { name: string; error: string }[] } | null>(null);
  const docScrollRef = useRef<HTMLDivElement>(null);

  // Page offset (virtual → real page mapping) — default Real mode
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const [savedPageOffset, setSavedPageOffset] = useState(0);
  const [pageMode, setPageMode] = useState<"virtual" | "real">("real");

  // Load page_offset from metadata
  useEffect(() => {
    if (!kbId || !docId) return;
    (async () => {
      try {
        const { getDocumentContent } = await import("../../services/tauriBridge");
        const doc = await getDocumentContent(kbId, docId);
        const offset = (doc as any).page_offset || 0;
        setSavedPageOffset(offset);
        setPageMode(offset > 0 ? "real" : "real"); // always default to real
      } catch {}
    })();
  }, [kbId, docId]);

  const savePageOffset = async (offset: number) => {
    if (!kbId || !docId) return;
    setSavedPageOffset(offset);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_page_offset", { kbId, docId, pageOffset: offset });
      // Also notify Python backend to apply offsets in search results
      try {
        const { pythonFetch } = await import("../../services/pythonClient");
        await pythonFetch("/utils/set-page-offset", {
          method: "POST",
          body: JSON.stringify({ kb_id: kbId, doc_id: docId, page_offset: offset }),
        });
      } catch {}
    } catch (e) {
      console.error("Failed to save page_offset:", e);
    }
  };

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

    // ── Tab cache: check if content already loaded ────────────
    const tab = useTabStore.getState().tabs.find((t) => t.kbId === kbId && t.docId === docId);
    if (tab?.content) {
      // Zero-latency tab switch — use cached data synchronously
      setContent(tab.content);
      setDocName(tab.docName);
      setMdAvailable(true);
      setStartCharMap(entriesToMap<number, number>(tab.startCharEntries));
      setPageChunksMap(entriesToMap<number, number[]>(tab.pageChunksEntries));
      setHasPageData((tab.pageAnchorPositions?.length ?? 0) > 0);
      setLoading(false);

      // Restore edit state if the tab was being edited
      if (tab.isEditing && tab.editContent != null) {
        setEditing(true);
        setEditContent(tab.editContent);
      }

      // Restore scroll position after a paint
      if (tab.scrollTop > 0) {
        requestAnimationFrame(() => {
          if (docScrollRef.current) {
            docScrollRef.current.scrollTop = tab.scrollTop;
          }
        });
      }

      // Background refresh if cache is stale
      if (isCacheStale(tab)) {
        (async () => {
          try {
            const doc = await getDocumentContent(kbId, docId);
            if (doc.markdown !== tab.content) {
              setContent(doc.markdown);
              setDocName(doc.name || doc.id);
              setMdAvailable(doc.md_available !== false);
            }
            // Update tab name if it was just the docId placeholder
            if (tab.docName === docId && doc.name) {
              useTabStore.getState().saveTabState(tab.id, { docName: doc.name });
            }
          } catch {}
          try {
            const res = await getChunkRange({ kb_id: kbId, doc_id: docId, start: 0, end: 50000 });
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
            // Update tab cache with fresh data
            useTabStore.getState().saveTabState(tab.id, {
              content: tab.content, // keep existing unless updated above
              cachedAt: Date.now(),
              startCharEntries: mapToEntries(map),
              pageChunksEntries: mapToEntries(pageMap),
            });
          } catch {}
        })();
      }
      return;
    }

    // ── Fresh fetch (no cache) ───────────────────────────────
    setLoading(true); setContent(""); setStartCharMap(new Map());
    (async () => {
      let curDocName = docId;
      let curContent = "";
      try {
        const doc = await getDocumentContent(kbId, docId);
        curDocName = doc.name || doc.id;
        curContent = doc.markdown;
        setDocName(curDocName);
        setContent(curContent);
        setMdAvailable(doc.md_available !== false);
      } catch { setDocName(docId); }
      try {
        const res = await getChunkRange({ kb_id: kbId, doc_id: docId, start: 0, end: 50000 });
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
        // Save to tab cache
        const curTab = useTabStore.getState().tabs.find((t) => t.kbId === kbId && t.docId === docId);
        if (curTab) {
          // Build page anchor positions for caching
          const positions: { page: number; startChar: number }[] = [];
          for (const [page, chunkIndices] of pageMap) {
            const sorted = [...chunkIndices].sort((a, b) => a - b);
            for (const ci of sorted) {
              const sc = map.get(ci);
              if (sc != null && sc >= 0) { positions.push({ page, startChar: sc }); break; }
            }
          }
          positions.sort((a, b) => b.startChar - a.startChar);
          useTabStore.getState().saveTabState(curTab.id, {
            docName: curDocName,
            content: curContent,
            cachedAt: Date.now(),
            startCharEntries: mapToEntries(map),
            pageChunksEntries: mapToEntries(pageMap),
            pageAnchorPositions: positions,
          });
        }
      } catch {}
      setLoading(false);
    })();
  }, [kbId, docId]);

  const handleStartEdit = () => {
    const initialContent = content;
    setEditContent(initialContent);
    setEditError("");
    setEditing(true);
    // Save edit state to tab store for cross-tab persistence
    const tab = useTabStore.getState().tabs.find((t) => t.kbId === kbId && t.docId === docId);
    if (tab) useTabStore.getState().saveTabState(tab.id, { isEditing: true, editContent: initialContent });
    // Position cursor at approximate reading position
    setTimeout(() => {
      const ta = document.querySelector(".doc-edit-textarea") as HTMLTextAreaElement | null;
      if (!ta) return;
      let charPos = 0;
      if (chunkIdx != null) {
        const sc = startCharMap.get(chunkIdx);
        if (sc != null && sc > 0) charPos = sc;
      }
      ta.focus();
      ta.setSelectionRange(charPos, charPos);
      const lineHeight = 20;
      const linesBefore = content.slice(0, charPos).split("\n").length;
      ta.scrollTop = Math.max(0, (linesBefore - 5) * lineHeight);
    }, 50);
  };
  const handleCancelEdit = () => {
    setEditing(false);
    setEditContent("");
    // Clear edit state and dirty flag
    const tab = useTabStore.getState().tabs.find((t) => t.kbId === kbId && t.docId === docId);
    if (tab) useTabStore.getState().saveTabState(tab.id, { isEditing: false, editContent: null, isDirty: false });
  };

  const jumpToChunk = useCallback((ci: number, heading?: { text: string; pos: number }) => {
    setSearchResults(null);
    window.history.replaceState({}, "", `?ci=${ci}`);
    jumpCounter.current += 1;
    setScrollTarget(heading ? { ...heading, n: jumpCounter.current } : null);
    setChunkIdx(ci);
    setJumpTrigger(n => n + 1);
  }, []);

  // Build char→chunk/page lookup and extract headings
  const charMaps = useMemo(
    () => buildCharMaps(startCharMap, pageChunksMap),
    [startCharMap, pageChunksMap],
  );
  const headings = useMemo(
    () => (content ? extractHeadings(content, charMaps.findChunk, charMaps.findPage) : []),
    [content, charMaps],
  );
  // Match active heading text to headings array index for TOC highlight
  const activeHeadingIndex = useMemo(() => {
    if (!activeHeadingText) return null;
    const idx = headings.findIndex((h) => h.text.trim() === activeHeadingText);
    return idx >= 0 ? idx : null;
  }, [activeHeadingText, headings]);
  const maxPage = useMemo(
    () => pageChunksMap.size > 0 ? Math.max(...pageChunksMap.keys()) : 0,
    [pageChunksMap],
  );
  const minPage = useMemo(
    () => pageChunksMap.size > 0 ? Math.min(...pageChunksMap.keys()) : 0,
    [pageChunksMap],
  );

  // page → chunk_index for the first chunk with valid start_char
  const pageToAnchorChunk = useMemo(() => {
    const map = new Map<number, number>();
    for (const [page, chunkIndices] of pageChunksMap) {
      const sorted = [...chunkIndices].sort((a, b) => a - b);
      for (const ci of sorted) {
        const sc = startCharMap.get(ci);
        if (sc != null && sc >= 0) { map.set(page, ci); break; }
      }
    }
    return map;
  }, [pageChunksMap, startCharMap]);

  const handlePageJump = useCallback(() => {
    const realPage = Number(pageInput);
    if (!Number.isFinite(realPage)) return;
    const virtualPage = realPage + savedPageOffset;
    let targetCi = pageToAnchorChunk.get(virtualPage);
    if (targetCi == null) {
      for (let np = virtualPage + 1; np <= maxPage; np++) {
        const nc = pageToAnchorChunk.get(np);
        if (nc != null) { targetCi = nc; break; }
      }
    }
    if (targetCi != null) {
      setPageJumpError("");
      jumpToChunk(targetCi);
    } else if (hasPageData) {
      setPageJumpError(t("docs.noChunksOnPage", { page: realPage }));
    }
  }, [pageInput, pageToAnchorChunk, hasPageData, t, jumpToChunk, maxPage, savedPageOffset]);

  // Page → startChar map for HTML anchor injection.
  // For each page, the anchor marks where that page's first text content
  // starts in the original markdown. Anchors are sorted high→low so
  // injection preserves earlier positions.
  const pageAnchorPositions = useMemo(() => {
    const positions: { page: number; startChar: number }[] = [];
    for (const [page, chunkIndices] of pageChunksMap) {
      const sorted = [...chunkIndices].sort((a, b) => a - b);
      for (const ci of sorted) {
        const sc = startCharMap.get(ci);
        if (sc != null && sc >= 0) {
          positions.push({ page, startChar: sc });
          break;
        }
      }
    }
    return positions.sort((a, b) => b.startChar - a.startChar);
  }, [pageChunksMap, startCharMap]);

  // Injected markdown: original content + <a id="page-N"> anchors.
  // rehypeRaw passes the anchors through to the DOM for precise scrolling.
  const anchoredContent = useMemo(() => {
    if (!content || pageAnchorPositions.length === 0) return content;
    let result = content;
    for (const { page, startChar } of pageAnchorPositions) {
      if (startChar < 0 || startChar > result.length) continue;
      const anchor = `<a id="page-${page}" data-page="${page}"></a>`;
      result = result.slice(0, startChar) + anchor + result.slice(startChar);
    }
    return result;
  }, [content, pageAnchorPositions]);

  const handleSave = async () => {
    if (!kbId || !docId) return;
    setSaving(true); setEditError("");
    try {
      await saveDocumentContent(kbId, docId, editContent);
      const { task_id } = await indexDocument({ kb_id: kbId, doc_id: docId, doc_name: docName, markdown_content: editContent });
      const r = await waitForIndex(task_id);
      await saveDocumentChunks(kbId, docId, r.chunk_count!, r.embedding_model!, r.embedding_dim!);
      setContent(editContent); setEditing(false);
      // Invalidate tab cache for this doc (other tabs viewing it need refresh)
      const curTab = useTabStore.getState().tabs.find((t) => t.kbId === kbId && t.docId === docId);
      if (curTab) {
        useTabStore.getState().saveTabState(curTab.id, {
          content: editContent,
          cachedAt: Date.now(),
          isDirty: false,
          isEditing: false,
          editContent: null,
          // Clear chunk caches since content changed
          startCharEntries: null,
          pageChunksEntries: null,
          pageAnchorPositions: null,
          headings: null,
        });
      }
    } catch (e) { setEditError(String(e)); }
    setSaving(false);
  };

  // ── Scroll position save/restore per tab ──────────────────────
  // Save scrollTop on unmount and on scroll (throttled)
  useEffect(() => {
    const container = docScrollRef.current;
    if (!container || !kbId || !docId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const tab = useTabStore.getState().tabs.find((t) => t.kbId === kbId && t.docId === docId);
        if (tab) {
          useTabStore.getState().saveTabState(tab.id, { scrollTop: container.scrollTop });
        }
      }, 200); // throttle to 200ms
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      // Final save on unmount or kbId/docId change
      const tab = useTabStore.getState().tabs.find((t) => t.kbId === kbId && t.docId === docId);
      if (tab) {
        useTabStore.getState().saveTabState(tab.id, { scrollTop: container.scrollTop });
      }
      container.removeEventListener("scroll", handleScroll);
      if (timer) clearTimeout(timer);
    };
  }, [kbId, docId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading document...</p>
      </div>
    );
  }

  if (!mdAvailable) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6 max-w-md mx-auto text-center">
        <AlertTriangle className="w-10 h-10 text-amber-500" />
        <div>
          <p className="text-sm font-medium">This document has no parsed content.</p>
          <p className="text-xs text-muted-foreground mt-1">It may be a parent document whose parts were indexed, or the parse has not completed.</p>
        </div>
        <div className="bg-muted rounded-lg p-3 w-full text-left">
          <p className="text-[10px] text-muted-foreground font-mono break-all">KB: {kbId}</p>
          <p className="text-[10px] text-muted-foreground font-mono break-all">Doc: {docId}</p>
        </div>
        <button onClick={() => navigate(`/kb/${kbId}`)} className="px-3 py-1.5 border rounded-md text-xs hover:bg-muted">
          ← Back to knowledge base
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col px-6 py-2 max-w-5xl mx-auto overflow-hidden" style={{ height: "100%" }}>
      {/* Header row: search/edit left, title center, TOC/images right */}
      <div className="flex items-center gap-2 mb-1 shrink-0">
        {/* Left: search + edit */}
        <div className="flex items-center gap-0.5 w-[56px] shrink-0">
          {editing ? (
            <>
              <button onClick={handleSave} disabled={saving} className="p-1 hover:bg-green-50 rounded text-green-600" title={t("docs.save")}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              </button>
              <button onClick={handleCancelEdit} disabled={saving} className="p-1 hover:bg-red-50 rounded text-red-500" title={t("kb.cancel")}>
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <>
              <button onClick={() => startTransition(() => setSearchOpen(!searchOpen))}
                className={`p-1 rounded transition-colors ${searchOpen ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"}`}
                title={t("search.searchBtn")}>
                <Search className="w-3.5 h-3.5" />
              </button>
              <button onClick={handleStartEdit} className="p-1 hover:bg-muted rounded text-muted-foreground" title={t("docs.editMarkdown")}>
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>

        {/* Center: doc name */}
        <div className="flex-1 flex items-center justify-center min-w-0">
          <FileText className="w-3.5 h-3.5 text-primary shrink-0 mr-1.5" />
          <h2 className="text-sm font-semibold truncate">{docName}</h2>
        </div>

        {/* Right: TOC + image toggles */}
        <div className="flex items-center gap-0.5 w-[56px] shrink-0 justify-end">
          {!editing && (
            <>
              <button onClick={() => wrappedSetTocOpen(!tocOpen)}
                className={`p-1 rounded transition-colors ${tocOpen ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"}`}
                title={t("docs.tocTitle")}>
                <List className="w-3.5 h-3.5" />
              </button>
              {imageNames.length > 0 && (
                <button onClick={() => startTransition(() => setImagesOpen(!imagesOpen))}
                  className={`p-1 rounded transition-colors ${imagesOpen ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"}`}
                  title="Images">
                  <ImageIcon className="w-3.5 h-3.5" />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {editError && <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 mb-1">{editError}</div>}
      {editing && <p className="text-[11px] text-muted-foreground mb-1">{t("docs.editHint")}</p>}

      {/* Collapsible search bar */}
      {/* ── Search Dialog ── */}
      {searchOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={() => setSearchOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative w-full max-w-xl bg-card border rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <input type="text" value={searchQuery} autoFocus
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Escape") { setSearchOpen(false); return; }
                  if (e.key !== "Enter" || !kbId || !docId || !searchQuery.trim()) return;
                  setSearching(true); setSearchError(""); setSearchResults(null);
                  try {
                    const r = await searchDocument({ kb_id: kbId, doc_id: docId, query: searchQuery.trim() });
                    setSearchResults(r.results);
                  } catch (err) { setSearchError(String(err)); }
                  setSearching(false);
                }}
                placeholder={t("docs.searchPlaceholder")}
                className="flex-1 text-sm bg-transparent border-none outline-none" />
              {searchQuery && (
                <button onClick={() => { setSearchQuery(""); setSearchResults(null); }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground">
                  <XCircle className="w-4 h-4" />
                </button>
              )}
              <button onClick={() => setSearchOpen(false)}
                className="p-1 rounded hover:bg-muted text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            {searching && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {searchError && <p className="px-4 py-2 text-sm text-red-500">{searchError}</p>}
            {pageJumpError && <p className="px-4 py-2 text-sm text-red-500">{pageJumpError}</p>}
            {searchResults && (
              <div className="max-h-[60vh] overflow-y-auto divide-y">
                {searchResults.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground text-center">{t("search.noResults")}</p>
                ) : (
                  searchResults.map((r, i) => (
                    <button key={i} onClick={() => {
                      const ci = r.metadata?.chunk_index;
                      if (ci != null) {
                        setSearchResults(null);
                        setSearchQuery("");
                        setSearchOpen(false);
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
        </div>
      )}

      {editing ? (
        <textarea value={editContent} onChange={e => {
            setEditContent(e.target.value);
            const tab = useTabStore.getState().tabs.find((t) => t.kbId === kbId && t.docId === docId);
            if (tab) {
              useTabStore.getState().saveTabState(tab.id, {
                editContent: e.target.value,
                isDirty: e.target.value !== content,
              });
            }
          }}
          className="doc-edit-textarea w-full min-h-[400px] p-4 border rounded-lg bg-background font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary"
          disabled={saving} />
      ) : (
        <DocView content={content} anchoredContent={anchoredContent} startCharMap={startCharMap} chunkIdx={chunkIdx} scrollTarget={scrollTarget} scrollRef={docScrollRef} kbId={kbId} docId={docId} pageAnchorPositions={pageAnchorPositions} jumpTrigger={jumpTrigger} onActiveHeadingChange={setActiveHeadingText} />
      )}

      {/* ── Fixed sidebar: TOC panel (Typora-style right sidebar) ── */}
      {!editing && tocOpen && (
        <div className="fixed z-30 flex flex-col bg-card border border-border rounded-lg shadow-lg overflow-hidden"
          style={{ top: 68, right: 12, width: 240, maxHeight: 'calc(100vh - 84px)' }}>
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50 shrink-0">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("docs.tocTitle")}</span>
            <div className="flex items-center gap-0.5">
              <button onClick={() => setPageSettingsOpen(true)}
                className="p-1 hover:bg-muted rounded text-muted-foreground" title="Page settings">
                <Settings className="w-3 h-3" />
              </button>
              <button onClick={() => wrappedSetTocOpen(false)} className="p-1 hover:bg-muted rounded text-muted-foreground">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div ref={(el) => {
              // heading list ref for auto-scroll
              if (el) {
                const container = el;
                // wait for ref to be attached before scrolling
              }
            }} className="flex-1 overflow-y-auto min-w-0 p-1">
              {headings.length === 0 ? (
                <p className="text-xs text-muted-foreground p-2">{t("docs.tocEmpty")}</p>
              ) : (
                headings.map((h, i) => {
                  const isActive = activeHeadingIndex === i;
                  return (
                    <button key={i}
                      onClick={() => { if (h.chunkIndex != null) jumpToChunk(h.chunkIndex, { text: h.text, pos: h.charOffset }); }}
                      className={`block w-full text-left px-2 py-1 rounded text-xs truncate transition-colors ${
                        isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-muted-foreground"
                      }`}
                      style={{ paddingLeft: `${4 + (h.level - 1) * 10}px` }}>
                      {h.text}
                    </button>
                  );
                })
              )}
            </div>
            {/* Page bar strip */}
            {hasPageData && maxPage > 0 && (
              <div className="w-9 shrink-0 overflow-y-auto border-l p-0.5">
                {(() => {
                  const pages: number[] = [];
                  for (let p = minPage; p <= maxPage; p++) pages.push(p);
                  const displayOffset = savedPageOffset;
                  return pages.map((p) => {
                    const displayP = p - displayOffset;
                    const label = displayP <= 0 ? toRoman(p) : String(displayP);
                    return (
                      <button key={p}
                        onClick={() => {
                          let targetCi = pageToAnchorChunk.get(p);
                          if (targetCi == null) {
                            for (let np = p + 1; np <= maxPage; np++) {
                              const nc = pageToAnchorChunk.get(np);
                              if (nc != null) { targetCi = nc; break; }
                            }
                          }
                          if (targetCi != null) jumpToChunk(targetCi);
                        }}
                        className="block w-full text-center py-0.5 text-[10px] tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground rounded transition-colors">
                        {label}
                      </button>
                    );
                  });
                })()}
              </div>
            )}
          </div>
          {/* Page jump input */}
          <div className="border-t p-2 shrink-0">
            <div className="flex gap-1">
              <input type="number" min={minPage} max={maxPage} value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handlePageJump(); }}
                disabled={!hasPageData}
                placeholder={hasPageData ? t("docs.pageJump") : "-"}
                className="flex-1 px-2 py-1.5 text-xs border rounded bg-background text-center focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-30 disabled:cursor-not-allowed" />
              <button onClick={handlePageJump}
                disabled={!hasPageData || !pageInput}
                className="px-2 py-1.5 text-xs border rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed">
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
            {pageJumpError && <p className="text-[10px] text-red-500 mt-1">{pageJumpError}</p>}
          </div>
        </div>
      )}

      {/* ── Fixed sidebar: Images panel ── */}
      {!editing && imagesOpen && (
        <div className="fixed z-30 flex flex-col bg-card border border-border rounded-lg shadow-lg overflow-hidden"
          style={{ top: 68, right: 12, width: 240, maxHeight: 'calc(100vh - 84px)' }}>
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50 shrink-0">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Images ({imageNames.length})</span>
            <div className="flex items-center gap-1">
              <FillMissingBtn kbId={kbId!} docId={docId!} taskId={fillTaskId} setTaskId={setFillTaskId} progress={fillProgress} setProgress={setFillProgress} />
              <button onClick={() => setGalleryMode(galleryMode === "grid" ? "list" : "grid")}
                className="p-1 hover:bg-muted rounded text-muted-foreground" title="Toggle view">
                {galleryMode === "grid" ? <Rows3 className="w-3 h-3" /> : <LayoutGrid className="w-3 h-3" />}
              </button>
              <button onClick={() => setImagesOpen(false)} className="p-1 hover:bg-muted rounded text-muted-foreground">
                <X className="w-3.5 h-3.5" />
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
      {pageSettingsOpen && (
        <PageSettingsDialog
          kbId={kbId!} docId={docId!}
          pageMode={pageMode} setPageMode={setPageMode}
          savedPageOffset={savedPageOffset}
          savePageOffset={savePageOffset}
          minPage={minPage} maxPage={maxPage}
          onClose={() => setPageSettingsOpen(false)}
          t={t}
        />
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

function PageSettingsDialog({
  kbId, docId, pageMode, setPageMode, savedPageOffset, savePageOffset, minPage, maxPage, onClose,
  t,
}: {
  kbId: string; docId: string;
  pageMode: "virtual" | "real"; setPageMode: (m: "virtual" | "real") => void;
  savedPageOffset: number; savePageOffset: (n: number) => void;
  minPage: number; maxPage: number;
  onClose: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: any, vars?: Record<string, string | number>) => string;
}) {
  // savedPageOffset = virtual - real. To show "virtual page N → real page 1",
  // the user enters N; we store offset = N - 1.
  const [offsetInput, setOffsetInput] = useState(
    String(savedPageOffset > 0 ? savedPageOffset + 1 : 0)
  );

  const handleSave = () => {
    const v = parseInt(offsetInput);
    if (!isNaN(v) && v >= 0) {
      const actualOffset = v > 0 ? v - 1 : 0;
      savePageOffset(actualOffset);
      setPageMode(actualOffset > 0 ? "real" : "real");
    }
    onClose();
  };

  const displayVirtualPage = (parseInt(offsetInput) || 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-card rounded-xl shadow-xl w-80 max-w-[90vw] p-5" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-sm mb-4">{t("docs.pageSettings")}</h3>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs">{t("docs.pageNumbering")}</span>
            <button onClick={() => setPageMode(pageMode === "real" ? "virtual" : "real")}
              className={`px-2 py-1 rounded text-xs font-medium ${pageMode === 'real' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
              {pageMode === 'real' ? t("docs.pageReal") : t("docs.pageVirtual")}
            </button>
          </div>

          <p className="text-[10px] text-muted-foreground">
            {pageMode === 'real' ? t("docs.pageRealHint") : t("docs.pageVirtualHint")}
          </p>

          <div className="flex items-center gap-2">
            <span className="text-xs shrink-0">{t("docs.pageVirtualPage")}</span>
            <input type="number" min={0} max={maxPage} value={offsetInput}
              onChange={e => setOffsetInput(e.target.value)}
              className="w-16 px-2 py-1 text-xs border rounded bg-background text-center" />
            <span className="text-xs">{t("docs.pageToReal1")}</span>
          </div>

          <p className="text-[10px] text-muted-foreground">
            {t("docs.pageBarHint", { v: String(Math.max(1, displayVirtualPage)) })}
          </p>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 px-3 py-1.5 border rounded-lg text-xs hover:bg-muted">{t("kb.cancel")}</button>
          <button onClick={handleSave} className="flex-1 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs">{t("docs.save")}</button>
        </div>
      </div>
    </div>
  );
}

function FillMissingBtn({ kbId, docId, taskId, setTaskId, progress, setProgress }: {
  kbId: string; docId: string;
  taskId: string | null; setTaskId: (v: string | null) => void;
  progress: { current: number; total: number; currentName: string; message: string; done: boolean; filled?: number; failed?: number; failed_details?: { name: string; error: string }[] } | null;
  setProgress: (p: { current: number; total: number; currentName: string; message: string; done: boolean; filled?: number; failed?: number; failed_details?: { name: string; error: string }[] } | null) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startPolling = (tid: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const { pollFillProgress } = await import("../../services/pythonClient");
        const p = await pollFillProgress(tid);
        setProgress({
          current: p.current,
          total: p.total,
          currentName: p.current_name || "",
          message: p.message || "",
          done: p.done,
          filled: p.filled,
          failed: p.failed,
          failed_details: p.failed_details,
        });
        if (p.done) stopPolling();
      } catch { /* ignore polling errors */ }
    }, 800);
  };

  const handleFill = async () => {
    setDialogOpen(true);
    // If there's already an active task, just reopen and resume polling
    if (taskId && progress && !progress.done) {
      if (!pollRef.current) startPolling(taskId);
      return;
    }
    // Start a new task
    setError(null);
    try {
      const { fillMissingImages } = await import("../../services/pythonClient");
      const r = await fillMissingImages(kbId, docId);
      if (r.done) {
        setProgress({ current: 0, total: 0, currentName: "", message: r.message || "All images have valid descriptions", done: true });
        setTaskId(null);
      } else {
        setTaskId(r.task_id);
        startPolling(r.task_id);
      }
    } catch (e) { setError(String(e)); }
  };

  // Cleanup polling on unmount
  useEffect(() => () => stopPolling(), []);

  const handleClose = () => {
    setDialogOpen(false);
    // Don't stop polling — task continues in background
  };

  // Re-attach polling if dialog reopens with active task
  useEffect(() => {
    if (dialogOpen && taskId && progress && !progress.done && !pollRef.current) {
      startPolling(taskId);
    }
  }, [dialogOpen, taskId]);

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <>
      <button onClick={handleFill}
        className="p-1 hover:bg-muted rounded text-muted-foreground disabled:opacity-40"
        title={taskId && progress && !progress.done ? `Filling... ${progress.current}/${progress.total}` : "Fill missing image descriptions with VLM"}>
        {taskId && progress && !progress.done ? <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" /> : <RefreshCw className="w-3.5 h-3.5" />}
      </button>

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={handleClose}>
          <div className="bg-card rounded-xl shadow-xl w-96 max-w-[90vw] p-6" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-sm mb-4">Fill Missing Image Descriptions</h3>

            {error ? (
              <div className="space-y-3">
                <p className="text-sm text-red-500">Error: {error}</p>
                <button onClick={() => { setDialogOpen(false); setError(null); }} className="w-full px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm">Close</button>
              </div>
            ) : progress?.done ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <Check className="w-4 h-4" />
                  <span>{progress.message}</span>
                </div>
                {progress.filled != null && (
                  <p className="text-xs text-muted-foreground">
                    {progress.filled} filled{progress.failed ? `, ${progress.failed} failed` : ""}
                  </p>
                )}
                {progress.failed_details && progress.failed_details.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border rounded-md divide-y">
                    {progress.failed_details.map((fd, i) => (
                      <div key={i} className="p-2 text-xs">
                        <p className="font-mono text-red-600 truncate">{fd.name}</p>
                        <p className="text-muted-foreground truncate">{fd.error}</p>
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={() => { setDialogOpen(false); setTaskId(null); setProgress(null); }} className="w-full px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm">Done</button>
              </div>
            ) : progress ? (
              <div className="space-y-3">
                <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                  <div className="bg-primary h-full rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  {progress.current}/{progress.total} — {progress.currentName || "..."}
                </p>
                {progress.message && <p className="text-xs text-muted-foreground text-center">{progress.message}</p>}
                <p className="text-xs text-muted-foreground text-center italic">You can close this dialog — the task continues in background.</p>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2 py-4">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Starting...</span>
              </div>
            )}

            {!progress?.done && progress && (
              <button onClick={handleClose} className="w-full mt-3 px-3 py-2 border rounded-lg text-sm hover:bg-muted">
                Close (continue in background)
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function DocToc({
  headings, tocOpen, setTocOpen, jumpToChunk, hasPageData, minPage, maxPage,
  pageChunksMap, pageToAnchorChunk, pageInput, setPageInput, handlePageJump, pageJumpError,
  pageMode, savedPageOffset, onOpenSettings, activeHeadingIndex,
  t,
}: {
  headings: Heading[];
  tocOpen: boolean;
  setTocOpen: (v: boolean) => void;
  jumpToChunk: (ci: number, heading?: { text: string; pos: number }) => void;
  hasPageData: boolean;
  minPage: number;
  maxPage: number;
  pageChunksMap: Map<number, number[]>;
  pageToAnchorChunk: Map<number, number>;
  pageInput: string; setPageInput: (v: string) => void;
  handlePageJump: () => void;
  pageJumpError: string;
  pageMode: "virtual" | "real"; savedPageOffset: number;
  onOpenSettings: () => void;
  activeHeadingIndex?: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: any, vars?: Record<string, string | number>) => string;
}) {
  // Display offset for page bar numbers (allows negative for front matter)
  const displayOffset = savedPageOffset;
  const headingsListRef = useRef<HTMLDivElement>(null);

  // Auto-scroll TOC headings list to keep active heading visible
  useEffect(() => {
    if (activeHeadingIndex == null || !headingsListRef.current) return;
    const el = headingsListRef.current.children[activeHeadingIndex] as HTMLElement | undefined;
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeHeadingIndex]);

  if (!tocOpen) return null;
  // Build linear page list from minPage to maxPage
  const pages: number[] = [];
  for (let p = minPage; p <= maxPage; p++) pages.push(p);

  return (
    <div className="w-56 shrink-0 border rounded-lg bg-card overflow-hidden flex flex-col max-h-[calc(100vh-140px)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50 shrink-0">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("docs.tocTitle")}</span>
        <div className="flex items-center gap-0.5">
          <button onClick={onOpenSettings}
            className="p-1 hover:bg-muted rounded text-muted-foreground" title="Page settings">
            <Settings className="w-3 h-3" />
          </button>
          <button onClick={() => setTocOpen(false)}
            className="p-1 hover:bg-muted rounded text-muted-foreground">
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body: headings (left) + linear page bar (right) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Headings column */}
        <div ref={headingsListRef} className="flex-1 overflow-y-auto min-w-0 p-1 border-r">
          {headings.length === 0 ? (
            <p className="text-xs text-muted-foreground p-2">{t("docs.tocEmpty")}</p>
          ) : (
            headings.map((h, i) => {
              const isActive = activeHeadingIndex === i;
              return (
              <button key={i}
                onClick={() => { if (h.chunkIndex != null) jumpToChunk(h.chunkIndex, { text: h.text, pos: h.charOffset }); }}
                className={`block w-full text-left px-2 py-1 rounded text-xs truncate transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "hover:bg-muted text-muted-foreground"
                }`}
                style={{ paddingLeft: `${4 + (h.level - 1) * 10}px` }}>
                {h.text}
              </button>
              );
            })
          )}
        </div>

        {/* Page bar — each clickable, shows offset-adjusted page numbers */}
        {hasPageData && maxPage > 0 && (
          <div className="w-9 shrink-0 overflow-y-auto p-0.5">
            {pages.map((p) => {
              const displayP = p - displayOffset;
              const label = displayP <= 0 ? toRoman(p) : String(displayP);
              return (
                <button key={p}
                  onClick={() => {
                    let targetCi = pageToAnchorChunk.get(p);
                    if (targetCi == null) {
                      for (let np = p + 1; np <= maxPage; np++) {
                        const nc = pageToAnchorChunk.get(np);
                        if (nc != null) { targetCi = nc; break; }
                      }
                    }
                    if (targetCi != null) jumpToChunk(targetCi);
                  }}
                  className="block w-full text-center py-0.5 text-[10px] tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground rounded transition-colors">
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Page jump at bottom */}
      <div className="border-t p-2 shrink-0">
        <div className="flex gap-1">
          <input type="number" min={minPage} max={maxPage} value={pageInput}
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

const DocView = memo(function DocView({ content, anchoredContent, startCharMap, chunkIdx, scrollTarget, scrollRef, kbId, docId, pageAnchorPositions, jumpTrigger, onActiveHeadingChange }: {
  content: string; anchoredContent: string; startCharMap: Map<number, number>; chunkIdx: number | null;
  scrollTarget?: { text: string; pos: number } | null;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  kbId?: string; docId?: string;
  pageAnchorPositions: { page: number; startChar: number }[];
  jumpTrigger: number;
  onActiveHeadingChange?: (headingText: string | null) => void;
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

  // Estimated cumulative scroll position for each section's top.
  // Used for instant scroll on page jump — scroll first (rough), then
  // render, then fine-tune with scrollIntoView. Estimation only needs
  // to be approximately right; final position is always set by
  // scrollIntoView after layout stabilizes.
  const sectionEstimatedTops = useMemo(() => {
    const tops: number[] = [];
    let cumulative = 0;
    for (let i = 0; i < sections.length; i++) {
      tops.push(cumulative);
      const sec = sections[i];
      // Rough estimate: ~80 chars per line × ~22px line height,
      // plus extra height for display math blocks ($$...$$).
      const displayMathCount = Math.floor(((sec.match(/\$\$/g) || []).length) / 2);
      const textLines = Math.ceil(sec.length / 80);
      const estimatedHeight = Math.max(200, textLines * 22 + displayMathCount * 50);
      cumulative += estimatedHeight;
    }
    return tops;
  }, [sections]);

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

  const EAGER = 2;
  // Sliding window: keep only this many sections above/below the target
  // to prevent DOM bloat from accumulating over multiple jumps.
  const WINDOW = 8;

  // Which section contains the target chunk (null if no target)
  const targetSecIdx: number | null = chunkIdx != null ? (chunkSection.get(chunkIdx) ?? null) : null;

  const [rendered, setRendered] = useState<Set<number>>(() => {
    const s = new Set<number>();
    for (let i = 0; i < Math.min(EAGER, sections.length); i++) s.add(i);
    if (targetSecIdx != null) {
      const lo = Math.max(0, targetSecIdx - 3);
      const hi = Math.min(sections.length - 1, targetSecIdx + 3);
      for (let i = lo; i <= hi; i++) s.add(i);
    }
    return s;
  });
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;

  // Ensure target section window is rendered (fires when targetSecIdx changes)
  useEffect(() => {
    if (targetSecIdx == null) return;
    startTransition(() => {
      setRendered(prev => {
        if (prev.has(targetSecIdx)) return prev;
        const s = new Set<number>();
        const lo = Math.max(0, targetSecIdx - 3);
        const hi = Math.min(sections.length - 1, targetSecIdx + 3);
        for (let i = lo; i <= hi; i++) s.add(i);
        for (let i = Math.max(0, targetSecIdx - WINDOW); i <= Math.min(sections.length - 1, targetSecIdx + WINDOW); i++) {
          if (prev.has(i)) s.add(i);
        }
        return s;
      });
    });
  }, [targetSecIdx]);

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
    }, { root: containerRef.current, rootMargin: "2500px" });
    sentinelsRef.current.forEach(el => obsRef.current?.observe(el));
    return () => obsRef.current?.disconnect();
  }, [sections]);

  const sentinelRef = useCallback((idx: number) => (el: HTMLDivElement | null) => {
    if (el) { sentinelsRef.current.set(idx, el); obsRef.current?.observe(el); }
    else { const old = sentinelsRef.current.get(idx); if (old) obsRef.current?.unobserve(old); sentinelsRef.current.delete(idx); }
  }, []);

  // ── Track active heading for TOC highlight ──────────────────────
  // Finds the heading closest to (but not below) the top of the viewport.
  // This gives "sticky" behavior: the heading stays highlighted as long
  // as the user is scrolling within its section.
  useEffect(() => {
    if (!onActiveHeadingChange) return;
    const scrollEl = containerRef.current;
    if (!scrollEl) return;
    const contentEl = containerRef.current;
    if (!contentEl) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const TOP_OFFSET = 60;

    const update = () => {
      timer = null;
      const allHeadings = contentEl.querySelectorAll('h1[id], h2[id], h3[id], h4[id]') as NodeListOf<HTMLElement>;
      if (allHeadings.length === 0) { onActiveHeadingChange(null); return; }

      const scrollTop = scrollEl.getBoundingClientRect().top + TOP_OFFSET;
      let activeText: string | null = null;
      for (const el of allHeadings) {
        if (el.getBoundingClientRect().top <= scrollTop) {
          activeText = (el.textContent ?? '').trim();
        } else {
          break;
        }
      }
      onActiveHeadingChange(activeText);
    };

    const handleScroll = () => {
      if (!timer) timer = setTimeout(update, 80);
    };
    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    const raf = requestAnimationFrame(update);
    return () => {
      scrollEl.removeEventListener('scroll', handleScroll);
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [sections, rendered, onActiveHeadingChange, scrollRef]);

  // Map chunk_index → page number (reverse of pageAnchorPositions)
  const chunkPageMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const { page, startChar } of pageAnchorPositions) {
      // Find which chunk this startChar belongs to
      for (const [ci, sc] of startCharMap) {
        if (sc === startChar) { map.set(ci, page); break; }
      }
    }
    return map;
  }, [pageAnchorPositions, startCharMap]);

  // Scroll to target heading/chunk.
  useEffect(() => {
    if (chunkIdx == null) return;

    // ── Page-bar jump: use HTML anchor ──
    if (!scrollTarget) {
      const pageNum = chunkPageMap.get(chunkIdx);
      if (pageNum != null) {
        // Ensure the section containing this page is rendered
        const sc = startCharMap.get(chunkIdx);
        if (sc != null) {
          const si = charToSection(sc);
          // Instant scroll to estimated position BEFORE triggering render.
          // This gives immediate visual feedback — the viewport moves
          // right away while KaTeX renders in the background. The final
          // precise position is set later by scrollIntoView.
          const container = containerRef.current;
          if (container && sectionEstimatedTops[si] != null) {
            container.scrollTop = sectionEstimatedTops[si];
          }
          // Render target section + neighbors, trim everything outside the
          // sliding window to prevent DOM bloat from accumulating over
          // multiple jumps (every jump adds sections, never removes them).
          setRendered(prev => {
            const s = new Set<number>();
            s.add(si);
            for (let i = Math.max(0, si - WINDOW); i <= Math.min(sections.length - 1, si + WINDOW); i++) {
              if (prev.has(i)) s.add(i);
            }
            return s;
          });
          startTransition(() => {
            setRendered(prev => {
              const s = new Set<number>();
              const lo = Math.max(0, si - 3);
              const hi = Math.min(sections.length - 1, si + 3);
              for (let i = lo; i <= hi; i++) s.add(i);
              // Preserve any already-rendered sections within the window
              for (let i = Math.max(0, si - WINDOW); i <= Math.min(sections.length - 1, si + WINDOW); i++) {
                if (prev.has(i)) s.add(i);
              }
              return s;
            });
          });
        }

        // Wait for the anchor and layout to stabilize before scrolling.
        // Phase 1: poll for anchor presence (up to 50 frames).
        // Phase 2: after anchor is found, wait 2 more frames for KaTeX
        //   layout to finish before scrollIntoView — this prevents
        //   scrolling to intermediate positions during layout shifts.
        let waitFrames = 0;
        let anchorFound = false;
        const tryAnchor = () => {
          const container = containerRef.current;
          if (!container) return;

          const anchor = container.querySelector(`#page-${pageNum}`) as HTMLElement | null;
          if (!anchor) {
            if (++waitFrames < 50) { requestAnimationFrame(tryAnchor); }
            return;
          }

          if (!anchorFound) {
            // Anchor just appeared — wait 2 more frames for KaTeX layout
            anchorFound = true;
            waitFrames = 0;
            requestAnimationFrame(tryAnchor);
            return;
          }

          if (++waitFrames < 3) {
            // Still waiting for layout to stabilize
            requestAnimationFrame(tryAnchor);
            return;
          }

          // Clear previous highlight
          if (highlightRef.current) {
            highlightRef.current.style.backgroundColor = "";
            highlightRef.current = null;
          }

          anchor.scrollIntoView({ block: "start", behavior: "instant" });

          // Highlight from this page's anchor to the next page's anchor
          const nextAnchor = container.querySelector(`#page-${pageNum + 1}`) as HTMLElement | null;
          const range = document.createRange();
          range.setStartAfter(anchor);
          if (nextAnchor) {
            range.setEndBefore(nextAnchor);
          } else {
            const lastChild = container.lastElementChild;
            if (lastChild) range.setEndAfter(lastChild);
          }
          const highlightEls: HTMLElement[] = [];
          const walker = document.createTreeWalker(
            range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT,
            { acceptNode: (node) => {
              if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
              const el = node as HTMLElement;
              if (el.id && el.id.startsWith('page-')) return NodeFilter.FILTER_SKIP;
              const tag = el.tagName;
              if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6' ||
                  tag === 'P' || tag === 'LI' || tag === 'TD' || tag === 'TH' || tag === 'PRE' || tag === 'BLOCKQUOTE') {
                return NodeFilter.FILTER_ACCEPT;
              }
              return NodeFilter.FILTER_SKIP;
            }}
          );
          let node: Node | null;
          while ((node = walker.nextNode())) { highlightEls.push(node as HTMLElement); }
          for (const el of highlightEls) {
            el.style.backgroundColor = "#fef3c7";
            el.style.transition = "background-color 0.5s";
          }
          highlightRef.current = null;
          setTimeout(() => {
            for (const el of highlightEls) { el.style.backgroundColor = ""; }
          }, 2500);
        };
        // Start immediately via rAF — no 80ms setTimeout penalty
        const raf = requestAnimationFrame(tryAnchor);
        return () => cancelAnimationFrame(raf);
      }
    }

    // ── TOC heading click: use heading text matching ──
    const secIdx = scrollTarget ? charToSection(scrollTarget.pos) : null;
    if (secIdx == null) return;

    // Instant scroll to estimated position before triggering render
    {
      const container = containerRef.current;
      if (container && sectionEstimatedTops[secIdx] != null) {
        container.scrollTop = sectionEstimatedTops[secIdx];
      }
    }

    setRendered(prev => {
      const s = new Set<number>();
      s.add(secIdx);
      for (let i = Math.max(0, secIdx - WINDOW); i <= Math.min(sections.length - 1, secIdx + WINDOW); i++) {
        if (prev.has(i)) s.add(i);
      }
      return s;
    });
    startTransition(() => {
      setRendered(prev => {
        const s = new Set<number>();
        for (let i = Math.max(0, secIdx - 3); i <= Math.min(sections.length - 1, secIdx + 3); i++) s.add(i);
        for (let i = Math.max(0, secIdx - WINDOW); i <= Math.min(sections.length - 1, secIdx + WINDOW); i++) {
          if (prev.has(i)) s.add(i);
        }
        return s;
      });
    });

    let attempts = 0;
    const tryHeading = () => {
      const container = containerRef.current;
      if (!container) return;

      if (highlightRef.current) {
        highlightRef.current.style.backgroundColor = "";
        highlightRef.current = null;
      }

      const sectionEl = container.querySelector(`[data-section-idx="${secIdx}"]`) as HTMLElement | null;
      if (!sectionEl || sectionEl.offsetHeight < 50) {
        if (++attempts < 10) { requestAnimationFrame(tryHeading); }
        return;
      }

      const stripMd = (s: string) => s.replace(/\s+/g, " ").replace(/[$*_`~]/g, "").trim();
      const want = stripMd(scrollTarget!.text);
      const domHeadings = sectionEl.querySelectorAll("h1, h2, h3");
      let targetEl: HTMLElement = sectionEl;
      for (const h of domHeadings) {
        if (stripMd(h.textContent || "") === want) { targetEl = h as HTMLElement; break; }
      }
      if (targetEl === sectionEl) {
        for (const h of domHeadings) {
          const t = stripMd(h.textContent || "");
          if (t && want && (t.includes(want) || want.includes(t))) { targetEl = h as HTMLElement; break; }
        }
      }

      targetEl.scrollIntoView({ block: "start", behavior: "instant" });
      targetEl.style.backgroundColor = "#fef3c7";
      targetEl.style.transition = "background-color 0.5s";
      highlightRef.current = targetEl;
      // Wait a few frames for KaTeX layout to stabilize, then re-adjust
      let settleFrames = 0;
      const settle = () => {
        if (++settleFrames <= 5) {
          targetEl.scrollIntoView({ block: "start", behavior: "instant" });
          requestAnimationFrame(settle);
          return;
        }
      };
      requestAnimationFrame(settle);
      setTimeout(() => {
        if (highlightRef.current === targetEl) {
          targetEl.style.backgroundColor = "";
          highlightRef.current = null;
        }
      }, 2500);
    };
    const raf2 = requestAnimationFrame(tryHeading);
    return () => cancelAnimationFrame(raf2);
  }, [chunkIdx, scrollTarget, jumpTrigger, sections.length, charToSection, startCharMap, chunkPageMap, sectionEstimatedTops]);


  // Single section: render with data-section-idx for consistency
  if (sections.length <= 1) {
    return (
      <div ref={containerRef as React.RefObject<HTMLDivElement>} id="doc-preview-scroll" className="flex-1 min-h-0 overflow-y-auto rounded-lg border bg-card prose prose-sm max-w-none dark:prose-invert p-6" style={{ overflowAnchor: "none" }}>
        <div data-section-idx={0}>
          <MarkdownRenderer imgKbId={kbId} imgDocId={docId}>{anchoredContent}</MarkdownRenderer>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef as React.RefObject<HTMLDivElement>} id="doc-preview-scroll" className="flex-1 min-h-0 overflow-y-auto rounded-lg border bg-card" style={{ overflowAnchor: "none" }}>
      <div className="prose prose-sm max-w-none dark:prose-invert p-6">
        {sections.map((sec, i) => {
          if (i < EAGER || rendered.has(i)) {
            // Inject page anchors that fall within this section
            const secStart = sectionOffsets[i];
            const secEnd = secStart + sec.length;
            let secWithAnchors = sec;
            for (const { page, startChar } of pageAnchorPositions) {
              if (startChar >= secStart && startChar < secEnd) {
                const relPos = startChar - secStart;
                secWithAnchors = secWithAnchors.slice(0, relPos) +
                  `<a id="page-${page}" data-page="${page}"></a>` +
                  secWithAnchors.slice(relPos);
              }
            }
            return (
              <div key={i} data-section-idx={i}>
                <MarkdownRenderer imgKbId={kbId} imgDocId={docId}>{secWithAnchors}</MarkdownRenderer>
              </div>
            );
          }
          return (
            <div key={i}>
              <div ref={sentinelRef(i)} data-section-idx={i} style={{ height: 1 }} />
              <div style={{ height: Math.max(200, sectionEstimatedTops[i + 1] - sectionEstimatedTops[i] || 200) }} />
            </div>
          );
        })}
      </div>
    </div>
  );
});
