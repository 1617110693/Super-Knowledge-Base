import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, X, RefreshCw, Loader2, Save, Pencil, Check } from "lucide-react";
import { readDocumentImage, getImageMeta, saveImageDesc } from "../../services/tauriBridge";

interface ImageInfo {
  name: string;
  page?: number;
  caption?: string;
}

interface ImageMetaFile {
  [filename: string]: {
    description?: string;
    entity_info?: { entity_name?: string; entity_type?: string; summary?: string };
    edited_at?: string;
  };
}

export function ImageDialog({
  images, currentIdx, onClose, kbId, docId, onPrev, onNext,
}: {
  images: ImageInfo[];
  currentIdx: number;
  onClose: () => void;
  kbId: string;
  docId: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  const img = images[currentIdx];
  const [src, setSrc] = useState("");
  const [meta, setMeta] = useState<ImageMetaFile>({});
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [vlmLoading, setVlmLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load image blob
  useEffect(() => {
    if (!img) return;
    let cancelled = false;
    (async () => {
      const bytes = await readDocumentImage(kbId, docId, img.name);
      if (cancelled) return;
      const blob = new Blob([new Uint8Array(bytes)]);
      setSrc(URL.createObjectURL(blob));
    })();
    return () => { cancelled = true; };
  }, [img, kbId, docId]);

  // Load metadata
  useEffect(() => {
    (async () => {
      try {
        const m = await getImageMeta(kbId!, docId!);
        setMeta(m as any);
      } catch {}
    })();
  }, [kbId, docId]);

  useEffect(() => {
    if (!img) return;
    const desc = meta[img.name]?.description || "";
    setEditText(desc);
    setEditing(false);
  }, [img, meta]);

  const currentDesc = img ? (meta[img.name]?.description || "") : "";

  const handleSaveDesc = async () => {
    if (!img || !kbId || !docId) return;
    setSaving(true);
    try {
      await saveImageDesc(kbId, docId, img.name, editText);
      setMeta(prev => ({ ...prev, [img.name]: { ...prev[img.name], description: editText } }));
      setSaved(true); setTimeout(() => setSaved(false), 2000);
      setEditing(false);
    } catch {}
    setSaving(false);
  };

  const handleReAnalyze = async () => {
    if (!img || !kbId || !docId) return;
    setVlmLoading(true);
    try {
      const { pythonFetch } = await import("../../services/pythonClient");
      const r = await pythonFetch<any>("/images/describe", {
        method: "POST",
        body: JSON.stringify({ kb_id: kbId, doc_id: docId, filename: img.name }),
      });
      if (r.description) {
        setEditText(r.description);
        await saveImageDesc(kbId, docId, img.name, r.description);
        setMeta(prev => ({ ...prev, [img.name]: { ...prev[img.name], description: r.description } }));
      }
    } catch (e) { console.error("VLM re-analyze failed:", e); }
    setVlmLoading(false);
  };

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowLeft") onPrev();
    if (e.key === "ArrowRight") onNext();
  }, [onClose, onPrev, onNext]);

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  if (!img) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <span className="text-white/80 text-sm">{currentIdx + 1} / {images.length}</span>
        <button onClick={onClose} className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"><X className="w-5 h-5" /></button>
      </div>

      {/* Prev/Next buttons */}
      <button onClick={e => { e.stopPropagation(); onPrev(); }}
        className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white z-10 disabled:opacity-30"
        disabled={currentIdx <= 0}>
        <ChevronLeft className="w-6 h-6" />
      </button>
      <button onClick={e => { e.stopPropagation(); onNext(); }}
        className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white z-10 disabled:opacity-30"
        disabled={currentIdx >= images.length - 1}>
        <ChevronRight className="w-6 h-6" />
      </button>

      <div className="flex gap-6 max-w-[90vw] max-h-[85vh]" onClick={e => e.stopPropagation()}>
        {/* Image */}
        <div className="flex items-center justify-center min-w-0 flex-1">
          {src ? <img src={src} alt={img.name} className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl" />
            : <Loader2 className="w-8 h-8 animate-spin text-white" />}
        </div>

        {/* Info Panel */}
        <div className="w-72 shrink-0 bg-card rounded-xl shadow-xl overflow-y-auto flex flex-col max-h-[85vh]">
          <div className="p-4 border-b">
            <h3 className="font-semibold text-sm truncate" title={img.name}>{img.name}</h3>
            {img.page && <p className="text-xs text-muted-foreground mt-1">Page {img.page}</p>}
            {img.caption && <p className="text-xs text-muted-foreground mt-1 italic">{img.caption}</p>}
          </div>

          <div className="flex-1 p-4 space-y-3 overflow-y-auto">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Description</span>
              <div className="flex gap-1">
                <button onClick={handleReAnalyze} disabled={vlmLoading}
                  className="p-1.5 hover:bg-muted rounded text-muted-foreground disabled:opacity-40"
                  title="Re-analyze with VLM">
                  {vlmLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                </button>
                {!editing ? (
                  <button onClick={() => { setEditing(true); setEditText(currentDesc); }}
                    className="p-1.5 hover:bg-muted rounded text-muted-foreground" title="Edit description">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button onClick={handleSaveDesc} disabled={saving}
                    className="p-1.5 hover:bg-green-50 rounded text-green-600" title="Save">
                    {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
            </div>

            {editing ? (
              <textarea value={editText} onChange={e => setEditText(e.target.value)}
                className="w-full min-h-[120px] p-2 border rounded-md text-xs bg-background resize-y focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="Enter description..." />
            ) : currentDesc ? (
              <p className="text-xs whitespace-pre-wrap text-muted-foreground leading-relaxed">{currentDesc}</p>
            ) : (
              <div className="text-xs text-muted-foreground space-y-2">
                <p>No description yet.</p>
                <p className="text-xs opacity-70">Click the refresh button above or the pencil to add a description.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}