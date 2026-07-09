import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface HighlightAnnotation {
  id: string;
  page: number;
  rect: Rect;
  rects?: Rect[];
  color: string;
  created_at: string;
}

export interface UnderlineAnnotation {
  id: string;
  page: number;
  rect: Rect;
  rects?: Rect[];
  color: string;
  created_at: string;
}

export interface StrikethroughAnnotation {
  id: string;
  page: number;
  rect: Rect;
  rects?: Rect[];
  color: string;
  created_at: string;
}

export interface NoteAnnotation {
  id: string;
  page: number;
  position: { x: number; y: number };
  content: string;
  created_at: string;
  rect?: Rect;
}

export interface Bookmark {
  id: string;
  page: number;
  label: string;
  created_at: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface DoodleAnnotation {
  id: string;
  page: number;
  points: Point[];
  color: string;
  stroke_width: number;
  created_at: string;
}

export interface AnnotationStore {
  highlights: HighlightAnnotation[];
  underlines: UnderlineAnnotation[];
  strikethroughs: StrikethroughAnnotation[];
  notes: NoteAnnotation[];
  bookmarks: Bookmark[];
  doodles: DoodleAnnotation[];
}

export interface PageAnnotations {
  highlights: HighlightAnnotation[];
  underlines: UnderlineAnnotation[];
  strikethroughs: StrikethroughAnnotation[];
  notes: NoteAnnotation[];
  doodles: DoodleAnnotation[];
}

// Semi-transparent highlight colors — text remains visible underneath
export const HIGHLIGHT_COLORS = [
  "rgba(245, 215, 140, 0.35)",
  "rgba(134, 239, 172, 0.35)",
  "rgba(147, 197, 253, 0.35)",
  "rgba(244, 114, 182, 0.35)",
  "rgba(196, 181, 253, 0.35)",
];

let idCounter = 0;
function genId() {
  return `ann_${Date.now()}_${++idCounter}`;
}

export const useAnnotationStore = defineStore("annotations", () => {
  const store = ref<AnnotationStore>({
    highlights: [],
    underlines: [],
    strikethroughs: [],
    notes: [],
    bookmarks: [],
    doodles: [],
  });

  // Persisted default highlight color (survives across sessions)
  const DEFAULT_COLOR_KEY = "pdfreader-default-color";
  const defaultColor = ref(HIGHLIGHT_COLORS[0]);
  try {
    const saved = localStorage.getItem(DEFAULT_COLOR_KEY);
    if (saved) defaultColor.value = saved;
  } catch {}

  function setDefaultColor(color: string) {
    defaultColor.value = color;
    try { localStorage.setItem(DEFAULT_COLOR_KEY, color); } catch {}
  }

  async function loadAnnotations(path: string) {
    try {
      const loaded = await invoke<AnnotationStore>("load_annotations", { path });
      store.value = loaded;
    } catch {
      store.value = { highlights: [], underlines: [], strikethroughs: [], notes: [], bookmarks: [], doodles: [] };
    }
  }

  async function saveAnnotations(path: string, page: number, zoom: number) {
    try {
      await invoke("save_annotations", { path, store: store.value, page, zoom });
    } catch (e) {
      console.error("Failed to save annotations:", e);
    }
  }

  // Compute bounding box from array of rects
  function boundingRect(rects: Rect[]): Rect {
    return {
      x1: Math.min(...rects.map(r => r.x1)),
      y1: Math.min(...rects.map(r => r.y1)),
      x2: Math.max(...rects.map(r => r.x2)),
      y2: Math.max(...rects.map(r => r.y2)),
    };
  }

  function addHighlight(
    page: number,
    rects: Rect[],
    color: string = defaultColor.value,
  ): string {
    const h: HighlightAnnotation = {
      id: genId(),
      page,
      rect: boundingRect(rects),
      rects: rects.length > 1 ? rects : undefined,
      color,
      created_at: new Date().toISOString(),
    };
    store.value.highlights.push(h);
    return h.id;
  }

  function addUnderline(
    page: number,
    rects: Rect[],
    color: string = defaultColor.value,
  ): string {
    const u: UnderlineAnnotation = {
      id: genId(),
      page,
      rect: boundingRect(rects),
      rects: rects.length > 1 ? rects : undefined,
      color,
      created_at: new Date().toISOString(),
    };
    store.value.underlines.push(u);
    return u.id;
  }

  function addStrikethrough(
    page: number,
    rects: Rect[],
    color: string = defaultColor.value,
  ): string {
    const s: StrikethroughAnnotation = {
      id: genId(),
      page,
      rect: boundingRect(rects),
      rects: rects.length > 1 ? rects : undefined,
      color,
      created_at: new Date().toISOString(),
    };
    store.value.strikethroughs.push(s);
    return s.id;
  }

  function addNote(
    page: number,
    position: { x: number; y: number },
    content: string,
    rect?: Rect,
  ): string {
    const n: NoteAnnotation = {
      id: genId(),
      page,
      position,
      content,
      rect,
      created_at: new Date().toISOString(),
    };
    store.value.notes.push(n);
    return n.id;
  }

  function addBookmark(page: number, label: string = ""): string {
    const b: Bookmark = {
      id: genId(),
      page,
      label: label || `Page ${page}`,
      created_at: new Date().toISOString(),
    };
    store.value.bookmarks.push(b);
    return b.id;
  }

  function addDoodle(
    page: number,
    points: Point[],
    color: string = defaultColor.value,
    stroke_width: number = 2,
  ): string {
    const d: DoodleAnnotation = {
      id: genId(),
      page,
      points,
      color,
      stroke_width,
      created_at: new Date().toISOString(),
    };
    store.value.doodles.push(d);
    return d.id;
  }

  function removeAnnotation(id: string) {
    store.value.highlights = store.value.highlights.filter((h) => h.id !== id);
    store.value.underlines = store.value.underlines.filter((u) => u.id !== id);
    store.value.strikethroughs = store.value.strikethroughs.filter((s) => s.id !== id);
    store.value.notes = store.value.notes.filter((n) => n.id !== id);
    store.value.bookmarks = store.value.bookmarks.filter((b) => b.id !== id);
    store.value.doodles = store.value.doodles.filter((d) => d.id !== id);
  }

  function updateAnnotationColor(id: string, color: string) {
    const h = store.value.highlights.find((h) => h.id === id);
    if (h) { h.color = color; return; }
    const u = store.value.underlines.find((u) => u.id === id);
    if (u) { u.color = color; return; }
    const s = store.value.strikethroughs.find((s) => s.id === id);
    if (s) { s.color = color; return; }
    const d = store.value.doodles.find((d) => d.id === id);
    if (d) { d.color = color; return; }
  }

  function updateNoteContent(id: string, content: string) {
    const n = store.value.notes.find((n) => n.id === id);
    if (n) n.content = content;
  }

  function getAnnotationsForPage(page: number): PageAnnotations {
    return {
      highlights: store.value.highlights.filter((h) => h.page === page),
      underlines: store.value.underlines.filter((u) => u.page === page),
      strikethroughs: store.value.strikethroughs.filter((s) => s.page === page),
      notes: store.value.notes.filter((n) => n.page === page),
      doodles: store.value.doodles.filter((d) => d.page === page),
    };
  }

  function undoLastHighlight(page: number) {
    const ph = store.value.highlights.filter((h) => h.page === page);
    if (ph.length > 0) {
      const last = ph[ph.length - 1];
      store.value.highlights = store.value.highlights.filter((h) => h.id !== last.id);
    }
  }

  function exportMarkdown(): string {
    const lines: string[] = ["# pdf-reader Annotations\n"];
    if (store.value.highlights.length) {
      lines.push("## Highlights\n");
      for (const h of store.value.highlights) {
        lines.push(`- Page ${h.page} (id: ${h.id})\n`);
      }
      lines.push("\n");
    }
    if (store.value.notes.length) {
      lines.push("## Notes\n");
      for (const n of store.value.notes) {
        lines.push(`- Page ${n.page}: ${n.content}\n`);
      }
      lines.push("\n");
    }
    return lines.join("");
  }

  return {
    store,
    defaultColor,
    setDefaultColor,
    loadAnnotations,
    saveAnnotations,
    addHighlight,
    addUnderline,
    addStrikethrough,
    addNote,
    addBookmark,
    addDoodle,
    removeAnnotation,
    updateAnnotationColor,
    updateNoteContent,
    getAnnotationsForPage,
    undoLastHighlight,
    exportMarkdown,
  };
});
