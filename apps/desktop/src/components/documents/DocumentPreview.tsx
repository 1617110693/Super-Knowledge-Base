import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { getDocumentContent, saveDocumentContent, saveDocumentChunks } from "../../services/tauriBridge";
import { indexDocument, getChunkRange } from "../../services/pythonClient";
import { useI18n } from "../../i18n";
import { FileText, Loader2, ArrowLeft, Pencil, Check, X } from "lucide-react";

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
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");

  const chunkIdx = (() => {
    const v = new URLSearchParams(window.location.search).get("ci");
    return v ? parseInt(v) : null;
  })();

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
        for (const c of (res.chunks || [])) {
          if (c.start_char != null) map.set(c.chunk_index, c.start_char);
        }
        setStartCharMap(map);
      } catch {}
      setLoading(false);
    })();
  }, [kbId, docId]);

  const handleStartEdit = () => { setEditContent(content); setEditError(""); setEditing(true); };
  const handleCancelEdit = () => { setEditing(false); setEditContent(""); };
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

      {editing ? (
        <textarea value={editContent} onChange={e => setEditContent(e.target.value)}
          className="w-full min-h-[400px] p-4 border rounded-lg bg-background font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary"
          disabled={saving} />
      ) : (
        <DocView key={`${chunkIdx ?? "no-chunk"}`} content={content} startCharMap={startCharMap} chunkIdx={chunkIdx} />
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

function DocView({ content, startCharMap, chunkIdx }: { content: string; startCharMap: Map<number, number>; chunkIdx: number | null }) {
  const sections = useMemo(() => splitSections(content), [content]);
  const sectionOffsets = useMemo(() => buildSectionOffsets(content, sections), [content, sections]);

  // Build sorted chunk entries: [chunkIndex, startChar, endChar]
  const chunkEntries = useMemo(() => {
    const sorted = [...startCharMap.entries()].sort((a, b) => a[0] - b[0]);
    return sorted.map(([idx, start], i) => {
      const end = i + 1 < sorted.length ? sorted[i + 1][1] : content.length;
      return { chunkIndex: idx, startChar: start, endChar: end };
    });
  }, [startCharMap, content]);

  // Map chunk_idx → section_idx
  const chunkSection = useMemo(() => {
    const map = new Map<number, number>();
    for (const e of chunkEntries) {
      map.set(e.chunkIndex, findSectionForChar(sectionOffsets, e.startChar));
    }
    return map;
  }, [chunkEntries, sectionOffsets]);

  const containerRef = useRef<HTMLDivElement>(null);
  const obsRef = useRef<IntersectionObserver | null>(null);
  const sentinelsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrolledRef = useRef(false);
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

  // Reset on chunkIdx change
  useEffect(() => { scrolledRef.current = false; }, [chunkIdx]);

  // Scroll to chunk: for multi-section docs, scroll target section into view.
  // For single-section docs, scroll to top of container.
  // Uses direct DOM scroll (no text search) — text search fails on
  // LaTeX math because KaTeX transforms the DOM content during rendering.
  // targetReady: only true when we have data and the target section is rendered
  const targetReady =
    targetSecIdx != null
      ? rendered.has(targetSecIdx)
      : (chunkIdx != null && sections.length <= 1 && chunkEntries.length > 0);
  useEffect(() => {
    if (!targetReady || scrolledRef.current) return;

    const container = containerRef.current;
    if (!container) return;

    // Clear previous highlight
    if (highlightRef.current) {
      highlightRef.current.style.backgroundColor = "";
      highlightRef.current = null;
    }

    if (targetSecIdx != null) {
      // Multi-section: scroll the target section element into view
      const sectionEl = container.querySelector(`[data-section-idx="${targetSecIdx}"]`) as HTMLElement | null;
      if (sectionEl) {
        scrolledRef.current = true;
        sectionEl.style.backgroundColor = "#fef3c7";
        sectionEl.style.transition = "background-color 0.5s";
        highlightRef.current = sectionEl;
        setTimeout(() => {
          if (highlightRef.current === sectionEl) {
            sectionEl.style.backgroundColor = "";
            highlightRef.current = null;
          }
        }, 2500);
        const containerRect = container.getBoundingClientRect();
        const sectionRect = sectionEl.getBoundingClientRect();
        const offset = sectionRect.top - containerRect.top - containerRect.height * 0.25;
        container.scrollTo({ top: container.scrollTop + offset, behavior: "instant" });
      }
    } else {
      // Single section: just scroll to top
      scrolledRef.current = true;
      container.scrollTo({ top: 0, behavior: "instant" });
      // Highlight the whole content area briefly
      const inner = container.firstElementChild as HTMLElement | null;
      if (inner) {
        inner.style.backgroundColor = "#fef3c7";
        inner.style.transition = "background-color 0.5s";
        highlightRef.current = inner;
        setTimeout(() => {
          if (highlightRef.current === inner) {
            inner.style.backgroundColor = "";
            highlightRef.current = null;
          }
        }, 2500);
      }
    }
  }, [targetReady, chunkIdx, targetSecIdx]);

  // Single section: render with data-section-idx for consistency
  if (sections.length <= 1) {
    return (
      <div ref={containerRef} id="doc-preview-scroll" className="max-h-[calc(100vh-200px)] overflow-y-auto rounded-lg border bg-card prose prose-sm max-w-none dark:prose-invert p-6">
        <div data-section-idx={0}>
          <MarkdownRenderer>{content}</MarkdownRenderer>
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
                <MarkdownRenderer>{sec}</MarkdownRenderer>
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
