<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useDocumentStore } from "@/stores/document";
import { useAnnotationStore, type Rect, HIGHLIGHT_COLORS } from "@/stores/annotations";
import { useUiStore } from "@/stores/ui";
import { useI18n } from "@/composables/useI18n";
import SelectionToolbar from "./SelectionToolbar.vue";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";

const doc = useDocumentStore();
const ann = useAnnotationStore();
const ui = useUiStore();
const { t } = useI18n();
const scrollRef = ref<HTMLDivElement | null>(null);
const spacerRef = ref<HTMLDivElement | null>(null);
const listRef = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const selToolbar = ref<InstanceType<typeof SelectionToolbar> | null>(null);
const ctxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null);
const notePopup = ref<{ x: number; y: number; id: string; content: string } | null>(null);

function onContextMenu(e: MouseEvent) {
  const target = e.target as HTMLElement;

  let annEl = target.closest(".ann-overlay") as HTMLElement | null;

  if (!annEl) {
    const wrapper = target.closest(".page-wrapper") as HTMLElement | null;
    if (wrapper) {
      for (const overlay of wrapper.querySelectorAll(".ann-overlay")) {
        const rect = overlay.getBoundingClientRect();
        if (
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom
        ) {
          annEl = overlay as HTMLElement;
          break;
        }
      }
    }
  }

  if (annEl) {
    e.preventDefault();
    const annId = annEl.dataset.annId;
    const annType = annEl.dataset.annType;
    if (!annId || !annType) return;

    const items: MenuItem[] = [];
    if (annType === "note") {
      items.push({
        label: t('delete_note'),
        danger: true,
        action: () => ann.removeAnnotation(annId),
      });
    } else {
      items.push({
        label: t('switch_color'),
        action: () => cycleAnnotationColor(annId, annType),
      });
      items.push({
        label: t('delete'),
        danger: true,
        action: () => ann.removeAnnotation(annId),
      });
    }

    ctxMenu.value = { x: e.clientX, y: e.clientY, items };
    return;
  }

  // Fallback: page right-click — add bookmark
  const pageWrapper = target.closest(".page-wrapper") as HTMLElement | null;
  if (pageWrapper) {
    e.preventDefault();
    const pageNum = Number(pageWrapper.dataset.page) || doc.currentPage;
    ctxMenu.value = {
      x: e.clientX,
      y: e.clientY,
      items: [{
        label: t('add_bookmark'),
        action: () => ann.addBookmark(pageNum),
      }],
    };
  }
}

function cycleAnnotationColor(id: string, type: string) {
  let currentColor = "";
  if (type === "highlight") {
    const h = ann.store.highlights.find((h) => h.id === id);
    if (h) currentColor = h.color;
  } else if (type === "underline") {
    const u = ann.store.underlines.find((u) => u.id === id);
    if (u) currentColor = u.color;
  } else if (type === "strikethrough") {
    const s = ann.store.strikethroughs.find((s) => s.id === id);
    if (s) currentColor = s.color;
  } else if (type === "doodle") {
    const d = ann.store.doodles.find((d) => d.id === id);
    if (d) currentColor = d.color;
  }
  const idx = HIGHLIGHT_COLORS.indexOf(currentColor);
  const nextColor = HIGHLIGHT_COLORS[(idx + 1) % HIGHLIGHT_COLORS.length];
  ann.updateAnnotationColor(id, nextColor);
}

function closeCtxMenu() {
  ctxMenu.value = null;
}

// ── Note popup: click note marker to view/edit ──
function onNoteMarkerClick(e: MouseEvent, noteId: string) {
  e.stopPropagation();
  e.preventDefault();
  const note = ann.store.notes.find((n) => n.id === noteId);
  if (!note) return;
  const marker = e.currentTarget as HTMLElement;
  const rect = marker.getBoundingClientRect();
  notePopup.value = {
    x: rect.right + 8,
    y: rect.top,
    id: noteId,
    content: note.content,
  };
}

function saveNotePopup() {
  if (!notePopup.value) return;
  ann.updateNoteContent(notePopup.value.id, notePopup.value.content);
  notePopup.value = null;
}

function deleteNotePopup() {
  if (!notePopup.value) return;
  ann.removeAnnotation(notePopup.value.id);
  notePopup.value = null;
}

function closeNotePopup() {
  notePopup.value = null;
}

interface PageEntry { canvas: HTMLCanvasElement | null; cssW: number; cssH: number }
const pageCache = new Map<number, PageEntry>();

let renderAborter: AbortController | null = null;
let zoomTimer: ReturnType<typeof setTimeout> | null = null;
let scrollingLock = 0;
let renderedZoom = 1.0;
const dpr = window.devicePixelRatio || 1;
let isRendering = false;

// Lazy rendering state
const renderedPages = new Set<number>();
const visiblePages = new Set<number>();
const renderingPages = new Set<number>();
let ioObserver: IntersectionObserver | null = null;
let scrollRafScheduled = false;

// 2D affine transform matrix multiplication (m1 × m2)
function transformMat(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

// Create transparent text layer for native text selection
async function createTextLayer(page: any, wrapper: HTMLElement, zoom: number, signal?: AbortSignal) {
  if (signal?.aborted) return;
  wrapper.querySelector(".text-layer")?.remove();
  let textContent;
  try { textContent = await page.getTextContent(); } catch { return; }
  if (signal?.aborted) return;
  const viewport = page.getViewport({ scale: zoom });
  const tlDiv = document.createElement("div");
  tlDiv.className = "text-layer";
  tlDiv.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;pointer-events:none;z-index:1;line-height:1;user-select:text;-webkit-user-select:text;";

  // First pass: group items by line (y-position within threshold) and find max font size per line
  const lineMaxFont = new Map<number, number>();
  const items: { tx: number[]; fontSize: number; str: string; yKey: number }[] = [];
  for (const item of textContent.items) {
    if (!item.str || !item.transform) continue;
    const tx = transformMat(viewport.transform, item.transform);
    const fontSize = Math.hypot(tx[2], tx[3]);
    if (fontSize < 0.5) continue;
    // Round y to nearest 2px to group items on the same line
    const yKey = Math.round(tx[5] / 2) * 2;
    items.push({ tx, fontSize, str: item.str, yKey });
    const cur = lineMaxFont.get(yKey) || 0;
    if (fontSize > cur) lineMaxFont.set(yKey, fontSize);
  }

  // Second pass: create spans with line-height = max font size on that line
  for (const { tx, fontSize, str, yKey } of items) {
    const span = document.createElement("span");
    span.textContent = str;
    const lineMax = lineMaxFont.get(yKey) || fontSize;
    // top = baseline - ascent(≈0.8*fontSize) centers selection background on visible glyphs
    // line-height = max font size on this line ensures selection background covers tallest elements
    span.style.cssText = `position:absolute;left:${tx[4]}px;top:${tx[5] - fontSize * 0.8}px;font-size:${fontSize}px;line-height:${lineMax}px;white-space:pre;color:transparent;pointer-events:auto;user-select:text;-webkit-user-select:text;`;
    tlDiv.appendChild(span);
  }
  wrapper.appendChild(tlDiv);
}

function lock() { scrollingLock++; }
function unlock() { if (--scrollingLock < 0) scrollingLock = 0; }
function isLocked() { return scrollingLock > 0; }

// ── Lazy render a single page (canvas + annotations + text layer) ──
async function renderSinglePage(pageNum: number) {
  if (renderedPages.has(pageNum) || renderingPages.has(pageNum)) return;
  if (!doc.pdfDoc || !listRef.value) return;
  renderingPages.add(pageNum);
  const startZoom = doc.zoom;
  try {
    const page = await doc.pdfDoc.getPage(pageNum);
    if (doc.zoom !== startZoom) return; // zoom changed during getPage, discard
    // Render at minimum 1.5× dpr for sharper text at all zoom levels
    const renderScale = Math.max(dpr * doc.zoom, dpr * 1.5);
    const viewport = page.getViewport({ scale: renderScale });
    const w = Math.round(viewport.width);
    const h = Math.round(viewport.height);
    const wrapper = listRef.value.querySelector(`.page-wrapper[data-page="${pageNum}"]`) as HTMLElement | null;
    if (!wrapper) return;
    // Lazily create canvas if not yet allocated (Phase 1 skips canvas creation)
    let canvas = wrapper.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.dataset.page = String(pageNum);
      canvas.style.cssText = "display:block;width:100%;height:100%;";
      wrapper.appendChild(canvas);
      const entry = pageCache.get(pageNum);
      if (entry) entry.canvas = canvas;
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (doc.zoom !== startZoom) return; // zoom changed during render, discard
    renderAnnotations(pageNum, wrapper);
    await createTextLayer(page, wrapper, doc.zoom);
    if (doc.zoom !== startZoom) return;
    renderedPages.add(pageNum);
  } catch (e: any) {
    if (e?.name !== "AbortError") console.error(`Page ${pageNum}:`, e);
  } finally {
    renderingPages.delete(pageNum);
  }
}

// ── IntersectionObserver: lazy render pages when they enter viewport ──
function setupIntersectionObserver() {
  if (!scrollRef.value || !listRef.value) return;
  ioObserver?.disconnect();
  ioObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pageNum = Number((entry.target as HTMLElement).dataset.page);
      if (!pageNum) continue;
      if (entry.isIntersecting) {
        visiblePages.add(pageNum);
        if (!renderedPages.has(pageNum)) {
          renderSinglePage(pageNum);
        }
      } else {
        visiblePages.delete(pageNum);
      }
    }
  }, {
    root: scrollRef.value,
    rootMargin: "200% 0px",
  });
  for (const wrapper of listRef.value.querySelectorAll(".page-wrapper")) {
    ioObserver.observe(wrapper);
  }
}

// ── Instant zoom: CSS transform (GPU-accelerated, zero reflow) ──
function applyZoomScale() {
  if (renderedZoom <= 0 || !listRef.value || !scrollRef.value || !spacerRef.value) return;
  const factor = doc.zoom / renderedZoom;
  if (factor === 1) return;

  const oldTop = scrollRef.value.scrollTop;
  const oldH = scrollRef.value.scrollHeight;
  const clientH = scrollRef.value.clientHeight;

  // Apply CSS transform — GPU composited, no layout reflow
  listRef.value.style.transform = `scale(${factor})`;

  // Set spacer height to match scaled content so scrollbar tracks correctly
  const baseH = listRef.value.offsetHeight; // un-transformed layout height
  spacerRef.value.style.height = `${Math.round(baseH * factor)}px`;

  // Preserve scroll position proportionally
  const newH = scrollRef.value.scrollHeight;
  if (oldH > clientH && newH > clientH) {
    const ratio = oldTop / (oldH - clientH);
    scrollRef.value.scrollTop = Math.round(ratio * (newH - clientH));
  }
}

// ── Commit zoom: remove transform, update real dimensions, re-render visible canvases ──
async function commitZoom() {
  if (!listRef.value || !scrollRef.value || !spacerRef.value || !doc.pdfDoc) {
    unlock();
    return;
  }

  // Save scroll ratio before layout changes
  const oldTop = scrollRef.value.scrollTop;
  const oldH = scrollRef.value.scrollHeight;
  const clientH = scrollRef.value.clientHeight;
  const ratio = oldH > clientH ? oldTop / (oldH - clientH) : 0;

  // Remove transform and spacer override
  listRef.value.style.transform = '';
  spacerRef.value.style.height = '';

  // Synchronously update ALL wrapper dimensions + dataset (prevents stale values on next zoom)
  const factor = doc.zoom / renderedZoom;
  if (factor !== 1) {
    for (const w of listRef.value.querySelectorAll<HTMLElement>('.page-wrapper')) {
      const cssw = parseFloat(w.dataset.cssw!);
      const cssh = parseFloat(w.dataset.cssh!);
      if (cssw) {
        const newW = cssw * factor;
        const newH = cssh * factor;
        w.style.width = `${newW}px`;
        w.style.height = `${newH}px`;
        w.dataset.cssw = String(newW);
        w.dataset.cssh = String(newH);
      }
    }
    for (const [, entry] of pageCache) {
      entry.cssW *= factor;
      entry.cssH *= factor;
    }
  }

  // Update renderedZoom early so rapid re-zoom computes correct factor
  renderedZoom = doc.zoom;

  // Adjust scroll position to maintain visual position
  const newH = scrollRef.value.scrollHeight;
  if (newH > clientH) {
    scrollRef.value.scrollTop = Math.round(ratio * (newH - clientH));
  }

  // Release lock early — dimension update is done, re-rendering can happen in background
  unlock();

  // Clear rendered pages — they need re-rendering at new zoom
  renderedPages.clear();

  // Re-render only visible pages (IO will handle the rest as user scrolls)
  if (!isRendering) {
    loading.value = true;
    const toRender = [...visiblePages].sort((a, b) => a - b);
    for (const p of toRender) {
      await renderSinglePage(p);
    }
    loading.value = false;
  }
}

// ── Initial render (document load only — creates DOM structure) ──
async function renderAllPages() {
  if (!doc.pdfDoc || !listRef.value) return;
  if (renderAborter) renderAborter.abort();
  const ctrl = new AbortController();
  renderAborter = ctrl;

  isRendering = true;
  lock();
  loading.value = true;
  const initZoom = doc.zoom;
  const pdf = doc.pdfDoc;

  // Clear previous state
  listRef.value.style.transform = '';
  if (spacerRef.value) spacerRef.value.style.height = '';

  // Cancel any pending zoom commit and release its lock
  if (zoomTimer) { clearTimeout(zoomTimer); zoomTimer = null; unlock(); }

  listRef.value.innerHTML = "";
  pageCache.clear();
  renderedPages.clear();
  visiblePages.clear();
  renderingPages.clear();
  ioObserver?.disconnect();

  // Phase 1: Create all page wrappers with correct CSS dimensions (fast — no canvas, no rendering)
  // This enables TOC/thumbnail/page-number navigation to any page immediately
  for (let p = 1; p <= pdf.numPages; p++) {
    if (ctrl.signal.aborted) break;
    try {
      const page = await pdf.getPage(p);
      // Use doc.zoom for CSS pixel dimensions only (canvases allocated lazily in renderSinglePage)
      const viewport = page.getViewport({ scale: doc.zoom });
      const cssW = Math.round(viewport.width);
      const cssH = Math.round(viewport.height);

      const wrapper = document.createElement("div");
      wrapper.className = "page-wrapper";
      wrapper.dataset.page = String(p);
      wrapper.dataset.cssw = String(cssW);
      wrapper.dataset.cssh = String(cssH);
      wrapper.style.cssText = `position:relative;margin:0 auto 8px;border-radius:2px;box-shadow:0 1px 4px rgba(0,0,0,0.08);width:${cssW}px;height:${cssH}px;background:#fff;`;

      wrapper.addEventListener("mousedown", (e) => onPageMouseDown(e, p));
      listRef.value.appendChild(wrapper);
      pageCache.set(p, { canvas: null, cssW, cssH });
    } catch (e: any) {
      if (e?.name !== "AbortError") console.error(`Page ${p}:`, e);
    }
  }

  // All wrappers exist — scroll to current page, then set up lazy rendering via IO
  nextTick(() => {
    scrollToPage(doc.currentPage, true);
    setupIntersectionObserver();
  });

  // Only update global state if this render is still the active one
  if (renderAborter === ctrl) {
    isRendering = false;
    loading.value = false;
    renderAborter = null;
    renderedZoom = initZoom;
  }
  unlock();
}

// ── Annotation overlays ──
function renderAnnotations(pageNum: number, wrapper: HTMLElement) {
  const anns = ann.getAnnotationsForPage(pageNum);
  wrapper.querySelectorAll(".ann-overlay").forEach(el => el.remove());

  // Helper: render a single highlight rect
  function makeHighlightRect(r: Rect, id: string, color: string): HTMLDivElement {
    const d = document.createElement("div");
    d.className = "ann-overlay";
    d.dataset.annId = id;
    d.dataset.annType = "highlight";
    d.style.cssText = `position:absolute;z-index:1;left:${r.x1 * 100}%;top:${r.y1 * 100}%;width:${(r.x2 - r.x1) * 100}%;height:${(r.y2 - r.y1) * 100}%;background:${color};border-radius:2px;pointer-events:none;`;
    return d;
  }

  for (const h of anns.highlights) {
    const rects = h.rects || [h.rect];
    for (const r of rects) {
      wrapper.appendChild(makeHighlightRect(r, h.id, h.color));
    }
  }

  // Helper: render underline at bottom of each rect (8px hit area via bounding box, 2px visible line)
  for (const u of anns.underlines) {
    const rects = u.rects || [u.rect];
    for (const r of rects) {
      const d = document.createElement("div");
      d.className = "ann-overlay";
      d.dataset.annId = u.id;
      d.dataset.annType = "underline";
      d.style.cssText = `position:absolute;z-index:1;left:${r.x1 * 100}%;top:calc(${r.y2 * 100}% - 8px);width:${(r.x2 - r.x1) * 100}%;height:8px;background:linear-gradient(to bottom, transparent 0, transparent 6px, ${u.color} 6px, ${u.color} 8px);border-radius:0;pointer-events:none;`;
      wrapper.appendChild(d);
    }
  }

  // Helper: render strikethrough at middle of each rect (8px hit area via bounding box, 2px visible line)
  for (const s of anns.strikethroughs) {
    const rects = s.rects || [s.rect];
    for (const r of rects) {
      const d = document.createElement("div");
      d.className = "ann-overlay";
      d.dataset.annId = s.id;
      d.dataset.annType = "strikethrough";
      d.style.cssText = `position:absolute;z-index:1;left:${r.x1 * 100}%;top:calc(${(r.y1 + r.y2) / 2 * 100}% - 4px);width:${(r.x2 - r.x1) * 100}%;height:8px;background:linear-gradient(to bottom, transparent 0, transparent 3px, ${s.color} 3px, ${s.color} 5px, transparent 5px);border-radius:0;pointer-events:none;`;
      wrapper.appendChild(d);
    }
  }

  for (const n of anns.notes) {
    // Render note selection rect if present (shows the area the note was attached to)
    if (n.rect) {
      const d = document.createElement("div");
      d.className = "ann-overlay ann-note-rect";
      d.dataset.annId = n.id;
      d.dataset.annType = "note";
      d.style.cssText = `position:absolute;z-index:1;left:${n.rect.x1 * 100}%;top:${n.rect.y1 * 100}%;width:${(n.rect.x2 - n.rect.x1) * 100}%;height:${(n.rect.y2 - n.rect.y1) * 100}%;background:rgba(255, 200, 80, 0.12);border:1.5px dashed rgba(255, 200, 80, 0.5);border-radius:2px;pointer-events:none;`;
      wrapper.appendChild(d);
    }
    // Note marker (clickable)
    const d = document.createElement("div");
    d.className = "ann-overlay ann-note-marker";
    d.dataset.annId = n.id;
    d.dataset.annType = "note";
    d.style.cssText = `position:absolute;z-index:2;left:${n.position.x * 100}%;top:${n.position.y * 100}%;width:18px;height:18px;margin-left:-9px;margin-top:-9px;background:var(--accent);border-radius:50%;pointer-events:auto;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);`;
    d.title = n.content;
    d.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16"><path d="M11 1.5l3.5 3.5L5 14l-4 1 1-4L11 1.5z" fill="none" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    d.addEventListener("click", (e) => onNoteMarkerClick(e, n.id));
    wrapper.appendChild(d);
  }

  // Doodles: render as SVG paths (fraction coords → viewBox 0..100)
  if (anns.doodles.length > 0) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;z-index:3;pointer-events:none;";

    for (const doodle of anns.doodles) {
      if (doodle.points.length < 2) continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      let d = `M ${doodle.points[0].x * 100} ${doodle.points[0].y * 100}`;
      for (let i = 1; i < doodle.points.length; i++) {
        d += ` L ${doodle.points[i].x * 100} ${doodle.points[i].y * 100}`;
      }
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", doodle.color);
      path.setAttribute("stroke-width", String(doodle.stroke_width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.classList.add("ann-overlay");
      path.setAttribute("data-ann-id", doodle.id);
      path.setAttribute("data-ann-type", "doodle");
      svg.appendChild(path);
    }
    wrapper.appendChild(svg);
  }
}

function refreshAllAnnotations() {
  if (!listRef.value) return;
  // Only refresh rendered pages (non-rendered pages have no overlay DOM)
  for (const p of renderedPages) {
    const wrapper = listRef.value.querySelector(`.page-wrapper[data-page="${p}"]`) as HTMLElement | null;
    if (wrapper) renderAnnotations(p, wrapper);
  }
}

// ── Scroll helpers ──
function scrollToPage(page: number, instant = false) {
  if (!scrollRef.value || !listRef.value) return;
  const el = listRef.value.querySelector(`[data-page="${page}"]`) as HTMLElement | null;
  if (!el) return;
  // Account for CSS transform: offsetTop is un-scaled, scroll is in scaled space
  const factor = renderedZoom > 0 ? doc.zoom / renderedZoom : 1;
  const top = el.offsetTop * factor - 20;
  const dist = Math.abs(scrollRef.value.scrollTop - top);
  const wasLocked = isLocked();
  if (!wasLocked) lock();
  const useSmooth = !instant && dist > scrollRef.value.clientHeight * 0.5;
  scrollRef.value.scrollTo({ top, behavior: useSmooth ? "smooth" : "instant" });
  setTimeout(() => { if (!wasLocked) unlock(); }, useSmooth ? (dist > 500 ? 600 : 200) : 60);
}

function detectCurrentPage() {
  if (!scrollRef.value || !listRef.value || isLocked()) return;
  if (listRef.value.children.length !== doc.pageCount) return;
  const factor = renderedZoom > 0 ? doc.zoom / renderedZoom : 1;
  const st = scrollRef.value.scrollTop + scrollRef.value.clientHeight * 0.3;
  let best = doc.currentPage;
  for (const child of listRef.value.children) {
    const p = Number((child as HTMLElement).dataset.page);
    if (p && (child as HTMLElement).offsetTop * factor <= st) best = p;
  }
  if (best !== doc.currentPage) {
    internalPageChange = true;
    lock();
    doc.setPage(best);
    nextTick(() => {
      unlock();
      internalPageChange = false;
    });
  }
}

// Flag: page change came from scroll detection (not user click) — prevents feedback loop
let internalPageChange = false;

// ── Drag-to-select rectangle ──
interface DragState {
  pageNum: number;
  wrapper: HTMLElement;
  rectEl: HTMLDivElement;
  startX: number; // mouse client X at mousedown
  startY: number;
}
let dragState: DragState | null = null;
let selRectEl: HTMLDivElement | null = null; // finalized selection rect (after drag ends)
let textSelecting = false; // true during native text selection (prevents onScroll from clearing it)

// ── Doodle (freehand drawing) state ──
interface DoodleState {
  pageNum: number;
  wrapper: HTMLElement;
  svg: SVGSVGElement;
  path: SVGPathElement;
  points: { x: number; y: number }[]; // fraction coordinates (0..1)
}
let doodleState: DoodleState | null = null;

function updateDoodlePath() {
  if (!doodleState) return;
  const pts = doodleState.points;
  if (pts.length === 0) return;
  let d = `M ${pts[0].x * 100} ${pts[0].y * 100}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x * 100} ${pts[i].y * 100}`;
  }
  doodleState.path.setAttribute("d", d);
}

function onPageMouseDown(e: MouseEvent, pageNum: number) {
  if (e.button !== 0) return; // left button only
  // Clear any previous selection
  clearSelection();

  // Doodle mode: start freehand drawing
  if (ui.doodleMode) {
    e.preventDefault();
    const wrapper = e.currentTarget as HTMLElement;
    const wRect = wrapper.getBoundingClientRect();
    const fx = (e.clientX - wRect.left) / wRect.width;
    const fy = (e.clientY - wRect.top) / wRect.height;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;z-index:3;pointer-events:none;";

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", ann.defaultColor);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("vector-effect", "non-scaling-stroke");

    svg.appendChild(path);
    wrapper.appendChild(svg);

    doodleState = { pageNum, wrapper, svg, path, points: [{ x: fx, y: fy }] };
    updateDoodlePath();
    return;
  }

  // If target is inside text layer, let browser handle native text selection
  if ((e.target as HTMLElement).closest(".text-layer")) {
    textSelecting = true;
    return;
  }
  e.preventDefault(); // prevent browser text selection during drag
  const wrapper = (e.currentTarget as HTMLElement);

  const rectEl = document.createElement("div");
  rectEl.className = "sel-rect";
  rectEl.style.cssText = "position:absolute;z-index:5;background:var(--highlight-bg);border:1.5px solid var(--highlight);border-radius:2px;pointer-events:none;left:0;top:0;width:0;height:0;";
  wrapper.appendChild(rectEl);

  dragState = {
    pageNum,
    wrapper,
    rectEl,
    startX: e.clientX,
    startY: e.clientY,
  };
}

function onDocMouseMove(e: MouseEvent) {
  // Doodle: add points to freehand stroke
  if (doodleState) {
    const { wrapper, points } = doodleState;
    const wRect = wrapper.getBoundingClientRect();
    const cx = Math.max(wRect.left, Math.min(e.clientX, wRect.right));
    const cy = Math.max(wRect.top, Math.min(e.clientY, wRect.bottom));
    points.push({ x: (cx - wRect.left) / wRect.width, y: (cy - wRect.top) / wRect.height });
    updateDoodlePath();
    return;
  }
  if (!dragState) return;
  const { wrapper, rectEl, startX, startY } = dragState;
  const wRect = wrapper.getBoundingClientRect();

  // Clamp mouse position within wrapper bounds
  const cx = Math.max(wRect.left, Math.min(e.clientX, wRect.right));
  const cy = Math.max(wRect.top, Math.min(e.clientY, wRect.bottom));

  const left = Math.min(startX, cx) - wRect.left;
  const top = Math.min(startY, cy) - wRect.top;
  const width = Math.abs(cx - startX);
  const height = Math.abs(cy - startY);

  rectEl.style.left = `${left}px`;
  rectEl.style.top = `${top}px`;
  rectEl.style.width = `${width}px`;
  rectEl.style.height = `${height}px`;
}

function onDocMouseUp() {
  // Finalize doodle: save if >= 2 points, remove temp SVG
  if (doodleState) {
    const { pageNum, points, svg } = doodleState;
    doodleState = null;
    if (points.length >= 2) {
      ann.addDoodle(pageNum, points);
    }
    svg.remove(); // temp SVG removed; store watcher triggers re-render from ann.store
    return;
  }
  if (textSelecting) textSelecting = false;
  if (!dragState) {
    // Check for native text selection (text layer)
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.toString().trim().length > 0) {
      const range = sel.getRangeAt(0);
      // Use getBoundingClientRect() for a single solid rectangle covering the entire selection
      // (includes gaps between lines and within lines — user wants the full bounding box)
      const boundingRect = range.getBoundingClientRect();
      const startEl = range.startContainer.parentElement;
      const wrapper = startEl?.closest(".page-wrapper") as HTMLElement | null;
      if (wrapper && boundingRect.width > 2 && boundingRect.height > 2) {
        const pageNum = Number(wrapper.dataset.page);
        const wRect = wrapper.getBoundingClientRect();
        const rect: Rect = {
          x1: (boundingRect.left - wRect.left) / wRect.width,
          y1: (boundingRect.top - wRect.top) / wRect.height,
          x2: (boundingRect.right - wRect.left) / wRect.width,
          y2: (boundingRect.bottom - wRect.top) / wRect.height,
        };
        const annRects: Rect[] = [rect];
        selRectEl = null;
        if (ui.penMode) {
          ann.addHighlight(pageNum, annRects);
          window.getSelection()?.removeAllRanges();
        } else {
          selToolbar.value?.show(boundingRect.left + boundingRect.width / 2, boundingRect.top, annRects, pageNum);
        }
      }
    }
    return;
  }
  const { wrapper, rectEl, pageNum } = dragState;
  const wRect = wrapper.getBoundingClientRect();
  const rRect = rectEl.getBoundingClientRect();

  const w = rRect.width;
  const h = rRect.height;

  // Treat as a click if too small — no selection
  if (w < 4 || h < 4) {
    clearSelection();
    return;
  }

  // Compute fraction-based rect (0..1) relative to page wrapper
  const rect: Rect = {
    x1: (rRect.left - wRect.left) / wRect.width,
    y1: (rRect.top - wRect.top) / wRect.height,
    x2: (rRect.right - wRect.left) / wRect.width,
    y2: (rRect.bottom - wRect.top) / wRect.height,
  };

  // Keep the rect visible, show toolbar above the selection
  selRectEl = rectEl;
  dragState = null;
  if (ui.penMode) {
    ann.addHighlight(pageNum, [rect]);
    clearSelection();
  } else {
    selToolbar.value?.show(rRect.left + w / 2, rRect.top, [rect], pageNum);
  }
}

function clearSelection() {
  if (doodleState) {
    doodleState.svg.remove();
    doodleState = null;
  }
  if (dragState) {
    dragState.rectEl.remove();
    dragState = null;
  }
  if (selRectEl) {
    selRectEl.remove();
    selRectEl = null;
  }
  window.getSelection()?.removeAllRanges();
  selToolbar.value?.hide();
}

// Called when SelectionToolbar hides itself (e.g. after applying annotation)
function onToolbarHide() {
  if (selRectEl) { selRectEl.remove(); selRectEl = null; }
  if (dragState) { dragState.rectEl.remove(); dragState = null; }
  window.getSelection()?.removeAllRanges();
}

// Watches
watch(() => doc.zoom, () => {
  if (!doc.pdfDoc) return;
  applyZoomScale();
  if (zoomTimer) clearTimeout(zoomTimer);
  else lock();
  zoomTimer = setTimeout(() => {
    zoomTimer = null;
    commitZoom();
  }, 200);
});
watch(() => doc.pdfDoc, (v) => { if (v) nextTick(renderAllPages); });
watch(() => doc.currentPage, (p) => {
  if (internalPageChange) return; // skip scroll for scroll-detected changes
  scrollToPage(p);
});
watch(() => ann.store, () => refreshAllAnnotations(), { deep: true });

function onScrollRaf() {
  scrollRafScheduled = false;
  if (textSelecting) return; // don't clear text selection during browser auto-scroll
  notePopup.value = null; // close note popup on scroll
  if (!isLocked()) detectCurrentPage();
  clearSelection();
}

function onScroll() {
  if (scrollRafScheduled) return;
  scrollRafScheduled = true;
  requestAnimationFrame(onScrollRaf);
}

onMounted(() => {
  if (doc.pdfDoc) renderAllPages();
  scrollRef.value?.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("mousemove", onDocMouseMove);
  document.addEventListener("mouseup", onDocMouseUp);
});
onUnmounted(() => {
  if (renderAborter) renderAborter.abort();
  if (zoomTimer) clearTimeout(zoomTimer);
  ioObserver?.disconnect();
  for (const [, e] of pageCache) if (e.canvas) e.canvas.remove();
  pageCache.clear();
  document.removeEventListener("mousemove", onDocMouseMove);
  document.removeEventListener("mouseup", onDocMouseUp);
});
</script>

<template>
  <div ref="scrollRef" class="pdf-viewport" :class="{ 'pen-mode': ui.penMode, 'doodle-mode': ui.doodleMode }" @contextmenu="onContextMenu" @click="closeNotePopup">
    <div v-if="!doc.document" class="empty-state">
      <div class="empty-icon">
        <svg width="48" height="48" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="12">
          <path d="M168 32H56a8 8 0 00-8 8v176a8 8 0 008 8h144a8 8 0 008-8V72z" />
          <polyline points="168 32 168 72 208 72" />
          <line x1="96" y1="104" x2="160" y2="104" /><line x1="96" y1="136" x2="160" y2="136" /><line x1="96" y1="168" x2="128" y2="168" />
        </svg>
      </div>
      <p class="empty-text">{{ t('empty_title') }}</p>
      <p class="empty-hint">{{ t('empty_hint') }}</p>
    </div>
    <div v-if="loading" class="loading-bar" />
    <div v-if="doc.document" ref="spacerRef" class="scroll-spacer">
      <div ref="listRef" class="page-list" />
    </div>
    <ContextMenu v-if="ctxMenu" :x="ctxMenu.x" :y="ctxMenu.y" :items="ctxMenu.items" @close="closeCtxMenu" />
    <SelectionToolbar ref="selToolbar" @hide="onToolbarHide" />
    <!-- Note popup: click note marker to view/edit -->
    <div v-if="notePopup" class="note-popup" :style="{ left: `${notePopup.x}px`, top: `${notePopup.y}px` }" @click.stop>
      <textarea v-model="notePopup.content" class="note-popup-textarea" :placeholder="t('note_placeholder')" rows="3" @keydown.escape="closeNotePopup" autofocus />
      <div class="note-popup-actions">
        <button class="note-popup-btn save" @click="saveNotePopup">{{ t('save') }}</button>
        <button class="note-popup-btn delete" @click="deleteNotePopup">{{ t('delete') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdf-viewport { flex: 1; position: relative; overflow-y: auto; background: var(--surface); user-select: none; -webkit-user-select: none; }
.pdf-viewport.pen-mode { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path d="M2 20l3-1L17 7l-2-2L4 16l-2 4z" fill="none" stroke="%23000" stroke-width="1.5" stroke-linejoin="round"/><path d="M15 5l2 2" stroke="%23000" stroke-width="1.5"/></svg>') 2 20, pointer; }
.pdf-viewport.pen-mode .text-layer span { cursor: text; }
.pdf-viewport.doodle-mode { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path d="M16 3l3 3-9 9-4 1 1-4 9-9z" fill="none" stroke="%23000" stroke-width="1.5" stroke-linejoin="round"/><path d="M15 4l3 3" stroke="%23000" stroke-width="1.5"/></svg>') 6 16, crosshair; }
.scroll-spacer { position: relative; }
.page-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 0;
  transform-origin: top center;
  will-change: transform;
}
.loading-bar {
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  background-size: 200% 100%;
  animation: shimmer 1.2s ease-in-out infinite; z-index: 10;
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; }
.empty-icon { color: var(--border); }
.empty-text { color: var(--text-muted); font-size: 14px; margin-top: 12px; }
.empty-hint { color: var(--text-muted); font-size: 12px; margin-top: 4px; opacity: 0.7; }

.note-popup {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}
.note-popup-textarea {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: "Geist", sans-serif;
  color: var(--text-primary);
  background: var(--surface);
  resize: none;
  outline: none;
  width: 220px;
}
.note-popup-textarea:focus { border-color: var(--accent); }
.note-popup-actions { display: flex; gap: 6px; justify-content: flex-end; }
.note-popup-btn {
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
  font-weight: 500;
  transition: background 150ms;
}
.note-popup-btn.save { background: var(--accent); color: #fff; }
.note-popup-btn.save:hover { opacity: 0.85; }
.note-popup-btn.delete { background: var(--accent-muted); color: var(--text-secondary); }
.note-popup-btn.delete:hover { background: #e81123; color: #fff; }
</style>

<style>
.text-layer span::selection {
  background: rgba(245, 215, 140, 0.4);
  color: transparent;
}
</style>
