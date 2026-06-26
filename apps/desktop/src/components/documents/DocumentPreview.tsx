import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { getDocumentContent, saveDocumentContent, saveDocumentChunks } from "../../services/tauriBridge";
import { indexDocument } from "../../services/pythonClient";
import { useI18n } from "../../i18n";
import { FileText, Loader2, ArrowLeft, Pencil, Check, X } from "lucide-react";

// ── Chunk anchor helpers ──
// Chunks are created at ~462-char intervals (chunk_size 512 − overlap 50).
const CHARS_PER_CHUNK = 462;

/** Insert invisible <span id="skb-c-N"> chunk anchors into the content.
 *  We only insert at paragraph boundaries (double-newline) to avoid
 *  breaking markdown syntax.  Each anchor marks where chunk N starts. */
function addChunkAnchors(content: string): string {
  const paragraphs = content.split(/\n\n+/);
  const result: string[] = [];
  let charOffset = 0;
  let nextAnchor = 0;
  for (const para of paragraphs) {
    while (nextAnchor * CHARS_PER_CHUNK <= charOffset) {
      result.push(`<span id="skb-c-${nextAnchor}">​</span>`);
      nextAnchor++;
    }
    result.push(para);
    charOffset += para.length + 2;
  }
  while (nextAnchor * CHARS_PER_CHUNK <= charOffset) {
    result.push(`<span id="skb-c-${nextAnchor}">​</span>`);
    nextAnchor++;
  }
  return result.join("\n\n");
}

// ── IntersectionObserver virtualizer ──
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

function VirtualDocView({ content, chunkIdx }: { content: string; chunkIdx?: number | null }) {
  const sections = useMemo(() => splitSections(content), [content]);
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [visibleSet, setVisibleSet] = useState<Set<number>>(new Set());
  const EAGER = 8;
  // When jumping to a chunk, render everything so anchors are in the DOM
  const fullRender = chunkIdx != null;

  const visibleRef = useRef(visibleSet);
  visibleRef.current = visibleSet;

  const setupObserver = useCallback(() => {
    if (observerRef.current) observerRef.current.disconnect();
    if (fullRender) return;
    observerRef.current = new IntersectionObserver(entries => {
      const next = new Set(visibleRef.current);
      let changed = false;
      for (const e of entries) {
        const idx = Number((e.target as HTMLElement).dataset.sectionIdx);
        if (!isNaN(idx) && e.isIntersecting && !next.has(idx)) {
          next.add(idx); changed = true;
        }
      }
      if (changed) setVisibleSet(next);
    }, { root: containerRef.current, rootMargin: "600px" });
    sentinelRefs.current.forEach(el => observerRef.current?.observe(el));
  }, [fullRender]);

  useEffect(() => {
    setupObserver();
    return () => observerRef.current?.disconnect();
  }, [setupObserver, sections]);

  const sentinelRef = useCallback((idx: number) => (el: HTMLDivElement | null) => {
    if (el) { sentinelRefs.current.set(idx, el); observerRef.current?.observe(el); }
    else { const old = sentinelRefs.current.get(idx); if (old) observerRef.current?.unobserve(old); sentinelRefs.current.delete(idx); }
  }, []);

  if (sections.length <= 1) {
    return (
      <div id="doc-preview-scroll" className="max-h-[calc(100vh-200px)] overflow-y-auto rounded-lg border bg-card">
        <MarkdownRenderer className="prose prose-sm max-w-none dark:prose-invert p-6">{content}</MarkdownRenderer>
      </div>
    );
  }

  return (
    <div id="doc-preview-scroll" ref={containerRef} className="max-h-[calc(100vh-200px)] overflow-y-auto rounded-lg border bg-card">
      <div className="prose prose-sm max-w-none dark:prose-invert p-6">
        {sections.map((sec, i) => {
          if (fullRender) {
            return (
              <div key={i}>
                <MarkdownRenderer>{sec}</MarkdownRenderer>
              </div>
            );
          }
          const visible = i < EAGER || visibleSet.has(i);
          return i < EAGER ? (
            <div key={i} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}>
              <MarkdownRenderer>{sec}</MarkdownRenderer>
            </div>
          ) : (
            <div key={i}>
              <div ref={sentinelRef(i)} data-section-idx={i} style={{ height: 1 }} />
              {visible ? (
                <div style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}>
                  <MarkdownRenderer>{sec}</MarkdownRenderer>
                </div>
              ) : (
                <div style={{ height: 200 }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main page ──
export function DocumentPreview() {
  const { kbId, docId } = useParams<{ kbId: string; docId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [content, setContent] = useState("");
  const [docName, setDocName] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const scrolledRef = useRef(false);

  const chunkIdx = useRef(parseInt(new URLSearchParams(window.location.search).get("ci") || "") || null).current;

  useEffect(() => {
    if (!kbId || !docId) return;
    setLoading(true); setContent(""); scrolledRef.current = false;
    getDocumentContent(kbId, docId).then(data => {
      setDocName(data.name || data.id);
      setTimeout(() => { setContent(data.markdown); setLoading(false); }, 30);
    }).catch(() => { setDocName(docId); setLoading(false); });
  }, [kbId, docId]);

  // ── Scroll to chunk anchor ──
  useEffect(() => {
    if (!content || scrolledRef.current || chunkIdx === null) return;
    scrolledRef.current = true;

    const anchorId = `skb-c-${chunkIdx}`;

    const tryScroll = (): boolean => {
      // Try the direct anchor first
      const el = document.getElementById(anchorId);
      if (el) {
        el.scrollIntoView({ behavior: "instant", block: "center" });
        // Brief highlight
        el.style.outline = "3px solid #f59e0b";
        el.style.outlineOffset = "2px";
        el.style.borderRadius = "4px";
        setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; el.style.borderRadius = ""; }, 2500);
        return true;
      }
      // Fallback: try nearby anchors
      for (let delta = 1; delta <= 5; delta++) {
        for (const sign of [-1, 1]) {
          const nearby = document.getElementById(`skb-c-${chunkIdx + sign * delta}`);
          if (nearby) {
            nearby.scrollIntoView({ behavior: "instant", block: "center" });
            return true;
          }
        }
      }
      // Last resort: proportional
      const container = document.getElementById("doc-preview-scroll");
      if (container && container.scrollHeight > 0) {
        const ratio = Math.min((chunkIdx * CHARS_PER_CHUNK) / content.length, 0.95);
        container.scrollTo({ top: ratio * container.scrollHeight - 80, behavior: "instant" });
        return true;
      }
      return false;
    };

    // Retry as sections progressively render
    let attempts = 0;
    const maxAttempts = 15;
    const retry = () => {
      if (tryScroll()) return;
      attempts++;
      if (attempts < maxAttempts) setTimeout(retry, 250);
    };
    const t = setTimeout(retry, 300);
    return () => clearTimeout(t);
  }, [content, chunkIdx]);

  const handleStartEdit = () => { setEditContent(content); setEditError(""); setEditing(true); };
  const handleCancelEdit = () => { setEditing(false); setEditContent(""); setEditError(""); };
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
      <button onClick={() => navigate(`/kb/${kbId}`)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors">
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
        <VirtualDocView content={addChunkAnchors(content)} chunkIdx={chunkIdx} />
      )}
    </div>
  );
}
