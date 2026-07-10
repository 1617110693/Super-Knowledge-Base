<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, markRaw } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ArrowLeft, Search, X, ChevronRight, FileText, Pencil, Check, XCircle,
  List, Image as ImageIcon, LayoutGrid, Rows3, Settings,
  AlertTriangle, RefreshCw, Save, Loader2,
} from "lucide-vue-next";
import MarkdownRenderer from "@/components/common/MarkdownRenderer.vue";
import PdfViewport from "@/components/reader/PdfViewport.vue";
import { useDocumentStore } from "@/stores/document";
import { useAnnotationStore } from "@/stores/annotations";
import { openDocumentFile } from "@/services/tauriBridge";

// ── PDF.js legacy worker (avoids private-field issues in Tauri webview) ──
let pdfjsWorker: Worker | null = null;
let pdfjsLibModule: any = null;
async function ensurePdfjs() {
  if (pdfjsLibModule) return pdfjsLibModule;
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.min.mjs");
  if (!pdfjsWorker) {
    pdfjsWorker = new Worker(
      new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url),
      { type: "module" }
    );
    pdfjsLib.GlobalWorkerOptions.workerPort = pdfjsWorker;
  }
  pdfjsLibModule = pdfjsLib;
  return pdfjsLib;
}
import {
  getDocumentContent, saveDocumentContent, saveDocumentChunks,
  listDocumentImages, readDocumentImage,
  getImageMeta, saveImageDesc,
} from "@/services/tauriBridge";
import {
  indexDocument, waitForIndex, getChunkRange, searchDocument,
  fillMissingImages, pollFillProgress,
} from "@/services/pythonClient";
import type { SearchResult } from "@/types";

// ── Utilities ──────────────────────────────────────────────────────────────

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

/** Build section byte offsets by finding each section in the original content. */
function buildSectionOffsets(content: string, sections: string[]): number[] {
  const offsets: number[] = [];
  let contentPos = 0;
  for (const sec of sections) {
    const idx = content.indexOf(sec, contentPos);
    if (idx >= 0) {
      offsets.push(idx);
      contentPos = idx + sec.length;
    } else {
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

// ── TOC Types ──────────────────────────────────────────────────────────────

interface Heading {
  level: number;
  text: string;
  charOffset: number;
  page?: number;
  chunkIndex?: number;
}

const HEADING_RE = /^(#{1,3})\s+(.+)$/gm;

/** Build (charOffset, chunkIndex) pairs from startCharMap, then lookup functions. */
function buildCharMaps(
  startCharMap: Map<number, number>,
  pageChunksMap: Map<number, number[]>,
) {
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
    const textPos = m.index + m[1].length + 1;
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

// ── Router & State ─────────────────────────────────────────────────────────

const route = useRoute();
const router = useRouter();

const kbId = computed(() => route.params.kbId as string);
const docId = computed(() => route.params.docId as string);

const content = ref("");
const docName = ref("");
const doc = ref<any>(null);
const loading = ref(true);
const startCharMap = ref<Map<number, number>>(new Map());
const pageChunksMap = ref<Map<number, number[]>>(new Map());
const hasPageData = ref(false);
const editing = ref(false);
const editContent = ref("");
const saving = ref(false);
const editError = ref("");
const searchQuery = ref("");
const pageInput = ref("");
const pageJumpError = ref("");
const searchResults = ref<SearchResult[] | null>(null);
const searching = ref(false);
const searchError = ref("");
const searchOpen = ref(false);
const activeHeadingText = ref<string | null>(null);
const mdAvailable = ref(true);

// PDF view mode
const viewMode = ref<"markdown" | "pdf">("markdown");
const docStore = useDocumentStore();
const annotationStore = useAnnotationStore();

// Open PDF file in PdfViewport
let pdfOpened = false;
async function openPdf() {
  if (!kbId.value || !docId.value) return;
  if (pdfOpened) { viewMode.value = "pdf"; return; }
  try {
    const filePath = await openDocumentFile(kbId.value, docId.value);
    if (!filePath) return;
    // Read file as binary (Tauri webview blocks file:// URLs)
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const data = await readFile(filePath);
    const pdfjsLib = await ensurePdfjs();
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
    const pdf = await loadingTask.promise;
    docStore.pdfDoc = markRaw(pdf);
    docStore.pageCount = pdf.numPages;
    docStore.document = { path: filePath } as any;
    docStore.currentPage = 1;
    docStore.zoom = 1.0;
    annotationStore.loadAnnotations(filePath);
    pdfOpened = true;
    viewMode.value = "pdf";
  } catch (e) {
    console.error("Failed to open PDF:", e);
  }
}

// TOC open state persisted per document
const tocOpen = ref(false);
const wrappedSetTocOpen = (v: boolean) => {
  tocOpen.value = v;
  try { localStorage.setItem(`skb-toc-${docId.value}`, String(v)); } catch { /* */ }
};

// Chunk index from URL or tab store
const chunkIdx = ref<number | null>(null);
const scrollTarget = ref<{ text: string; pos: number; n: number } | null>(null);
const jumpTrigger = ref(0);
const jumpCounter = { current: 0 };

// Images
const imageNames = ref<string[]>([]);
const imageSrcs = ref<Map<string, string>>(new Map());
const imagesOpen = ref(false);
const galleryMode = ref<"grid" | "list">("grid");
const dialogIdx = ref<number | null>(null);
const imageMeta = ref<Record<string, any>>({});
const editingDesc = ref(false);
const descEditText = ref("");
const descSaving = ref(false);
const vlmLoading = ref(false);

// VLM fill task
const fillTaskId = ref<string | null>(null);
const fillProgress = ref<{
  current: number; total: number; currentName: string;
  message: string; done: boolean; filled?: number; failed?: number;
  failed_details?: { name: string; error: string }[];
} | null>(null);

// Page settings
const pageSettingsOpen = ref(false);
const savedPageOffset = ref(0);
const pageMode = ref<"virtual" | "real">("real");

// Scroll ref
const docScrollRef = ref<HTMLDivElement | null>(null);

// Tab cache (simplified — full tab store integration would go through useTabStore)
interface TabCache {
  content: string;
  docName: string;
  scrollTop: number;
  startCharEntries: [number, number][];
  pageChunksEntries: [number, number[]][];
  pageAnchorPositions: { page: number; startChar: number }[];
  cachedAt: number;
  isEditing: boolean;
  editContent: string | null;
}
const tabCache = ref<TabCache | null>(null);

// ── Derived: char maps, headings, pages ────────────────────────────────────

const charMaps = computed(() => buildCharMaps(startCharMap.value, pageChunksMap.value));

const headings = computed(() =>
  content.value
    ? extractHeadings(content.value, charMaps.value.findChunk, charMaps.value.findPage)
    : [],
);

const activeHeadingIndex = computed(() => {
  if (!activeHeadingText.value) return null;
  const idx = headings.value.findIndex((h) => h.text.trim() === activeHeadingText.value);
  return idx >= 0 ? idx : null;
});

const maxPage = computed(() =>
  pageChunksMap.value.size > 0 ? Math.max(...pageChunksMap.value.keys()) : 0,
);

const minPage = computed(() =>
  pageChunksMap.value.size > 0 ? Math.min(...pageChunksMap.value.keys()) : 0,
);

const pageToAnchorChunk = computed(() => {
  const map = new Map<number, number>();
  for (const [page, chunkIndices] of pageChunksMap.value) {
    const sorted = [...chunkIndices].sort((a, b) => a - b);
    for (const ci of sorted) {
      const sc = startCharMap.value.get(ci);
      if (sc != null && sc >= 0) { map.set(page, ci); break; }
    }
  }
  return map;
});

const pageAnchorPositions = computed(() => {
  const positions: { page: number; startChar: number }[] = [];
  for (const [page, chunkIndices] of pageChunksMap.value) {
    const sorted = [...chunkIndices].sort((a, b) => a - b);
    for (const ci of sorted) {
      const sc = startCharMap.value.get(ci);
      if (sc != null && sc >= 0) {
        positions.push({ page, startChar: sc });
        break;
      }
    }
  }
  return positions.sort((a, b) => b.startChar - a.startChar);
});

// ── Page offset loading ────────────────────────────────────────────────────

watch([kbId, docId], async () => {
  if (!kbId.value || !docId.value) return;
  try {
    const doc = await getDocumentContent(kbId.value, docId.value);
    const offset = (doc as any).page_offset || 0;
    savedPageOffset.value = offset;
    pageMode.value = "real";
  } catch { /* ignore */ }
}, { immediate: true });

const savePageOffset = async (offset: number) => {
  if (!kbId.value || !docId.value) return;
  savedPageOffset.value = offset;
  try {
    // Tauri command
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    await tauriInvoke("set_page_offset", { kbId: kbId.value, docId: docId.value, pageOffset: offset });
    // Also notify Python backend
    try {
      const { pythonFetch } = await import("@/services/pythonClient");
      await pythonFetch("/utils/set-page-offset", {
        method: "POST",
        body: JSON.stringify({ kb_id: kbId.value, doc_id: docId.value, page_offset: offset }),
      });
    } catch { /* ignore */ }
  } catch (e) {
    console.error("Failed to save page_offset:", e);
  }
};

// ── Image loading ──────────────────────────────────────────────────────────

watch([kbId, docId], async () => {
  if (!kbId.value || !docId.value) return;
  try {
    const names = await listDocumentImages(kbId.value, docId.value);
    imageNames.value = names;
    if (names.length > 0) {
      const srcs = new Map<string, string>();
      for (const name of names.slice(0, 20)) {
        try {
          const bytes = await readDocumentImage(kbId.value, docId.value, name);
          const blob = new Blob([new Uint8Array(bytes)]);
          srcs.set(name, URL.createObjectURL(blob));
        } catch { /* ignore */ }
      }
      imageSrcs.value = srcs;
    }
  } catch { /* ignore */ }
}, { immediate: true });

// Load all thumbnails when images panel opens
watch(imagesOpen, async (open) => {
  if (!open || !kbId.value || !docId.value) return;
  for (const name of imageNames.value) {
    if (imageSrcs.value.has(name)) continue;
    try {
      const bytes = await readDocumentImage(kbId.value, docId.value, name);
      const blob = new Blob([new Uint8Array(bytes)]);
      imageSrcs.value = new Map(imageSrcs.value).set(name, URL.createObjectURL(blob));
    } catch { /* ignore */ }
  }
});

// ── Main content loading ───────────────────────────────────────────────────

watch([kbId, docId], async ([newKbId, newDocId], [oldKbId, oldDocId]) => {
  if (!newKbId || !newDocId) return;

  // Save scroll position of previous doc
  if (oldKbId && oldDocId && docScrollRef.value) {
    try {
      const key = `skb-scroll-${oldKbId}-${oldDocId}`;
      localStorage.setItem(key, String(docScrollRef.value.scrollTop));
    } catch { /* ignore */ }
  }

  // Check for cached content
  const cached = tabCache.value;
  if (cached && cached.content) {
    content.value = cached.content;
    docName.value = cached.docName;
    mdAvailable.value = true;
    startCharMap.value = new Map(cached.startCharEntries);
    pageChunksMap.value = new Map(cached.pageChunksEntries);
    hasPageData.value = cached.pageAnchorPositions.length > 0;
    loading.value = false;

    if (cached.isEditing && cached.editContent != null) {
      editing.value = true;
      editContent.value = cached.editContent;
    }

    if (cached.scrollTop > 0) {
      nextTick(() => {
        if (docScrollRef.value) {
          docScrollRef.value.scrollTop = cached.scrollTop;
        }
      });
    }

    // Background refresh if cache is stale (> 30s)
    if (Date.now() - cached.cachedAt > 30000) {
      refreshContent();
    }
    return;
  }

  // Fresh fetch
  loading.value = true;
  content.value = "";
  startCharMap.value = new Map();

  let curDocName = newDocId;
  let curContent = "";
  try {
    const docData = await getDocumentContent(newKbId, newDocId);
    doc.value = docData;
    curDocName = docData.name || docData.id;
    curContent = docData.markdown;
    // Pre-process MinerU multi-line $...\tag{}...$ into $$...$$ before section splitting
    curContent = curContent.replace(/^\$\n([\s\S]*?)\\tag\{([^}]+)\}\n\s*\$$/gm, '$$\n$1\n\\tag{$2}\n$$');
    docName.value = curDocName;
    content.value = curContent;
    mdAvailable.value = docData.md_available !== false;
  } catch { docName.value = newDocId; }

  // Resolve image paths in content BEFORE populating startCharMap so positions match
  if (content.value && imageNames.value.length > 0) {
    for (const name of imageNames.value) {
      const src = imageSrcs.value.get(name);
      if (src) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Markdown image syntax: ![...](images/xxx.jpg)
        content.value = content.value.replace(
          new RegExp(`\\(images/${escaped}\\)`, 'g'),
          `(${src})`
        );
        // HTML img with double quotes
        content.value = content.value.replace(
          new RegExp(`src="images/${escaped}"`, 'g'),
          `src="${src}"`
        );
        // HTML img with single quotes
        content.value = content.value.replace(
          new RegExp(`src='images/${escaped}'`, 'g'),
          `src='${src}'`
        );
        // HTML img without quotes: src=images/xxx.jpg
        content.value = content.value.replace(
          new RegExp(`src=images/${escaped}(?=[\\s>])`, 'g'),
          `src=${src}`
        );
      }
    }
  }

  try {
    const res = await getChunkRange({ kb_id: newKbId, doc_id: newDocId, start: 0, end: 50000 });
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
    startCharMap.value = map;
    pageChunksMap.value = pageMap;
    hasPageData.value = anyPage;

    const positions: { page: number; startChar: number }[] = [];
    for (const [page, chunkIndices] of pageMap) {
      const sorted = [...chunkIndices].sort((a, b) => a - b);
      for (const ci of sorted) {
        const sc = map.get(ci);
        if (sc != null && sc >= 0) { positions.push({ page, startChar: sc }); break; }
      }
    }
    positions.sort((a, b) => b.startChar - a.startChar);
    tabCache.value = {
      content: curContent,
      docName: curDocName,
      scrollTop: 0,
      startCharEntries: [...map],
      pageChunksEntries: [...pageMap],
      pageAnchorPositions: positions,
      cachedAt: Date.now(),
      isEditing: false,
      editContent: null,
    };
  } catch { /* ignore */ }

  loading.value = false;

  // Restore previous scroll position
  try {
    const key = `skb-scroll-${newKbId}-${newDocId}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      const top = parseInt(saved);
      if (!isNaN(top) && top > 0) {
        nextTick(() => {
          if (docScrollRef.value) {
            docScrollRef.value.scrollTop = top;
            // Ensure sections at the scroll position are rendered
            const estTops = sectionEstimatedTops.value;
            let targetSi = 0;
            for (let i = estTops.length - 1; i >= 0; i--) {
              if (top >= estTops[i]) { targetSi = i; break; }
            }
            rendered.value = new Set([
              ...rendered.value,
              ...Array.from({ length: 2 * WINDOW + 1 }, (_, i) =>
                Math.max(0, targetSi - WINDOW + i)).filter((i) => i < sections.value.length),
            ]);
          }
        });
      }
    }
  } catch { /* ignore */ }
}, { immediate: true });

async function refreshContent() {
  if (!kbId.value || !docId.value) return;
  try {
    const doc = await getDocumentContent(kbId.value, docId.value);
    if (doc.markdown !== content.value) {
      content.value = doc.markdown;
      docName.value = doc.name || doc.id;
      mdAvailable.value = doc.md_available !== false;
    }
  } catch { /* ignore */ }
  try {
    const res = await getChunkRange({ kb_id: kbId.value, doc_id: docId.value, start: 0, end: 50000 });
    const map = new Map<number, number>();
    const pageMap = new Map<number, number[]>();
    for (const c of (res.chunks || [])) {
      if (c.start_char != null) map.set(c.chunk_index, c.start_char);
      const ps = c.page_start ?? 0;
      const pe = c.page_end ?? 0;
      for (let p = Math.max(1, ps); p <= Math.max(ps, pe); p++) {
        if (!pageMap.has(p)) pageMap.set(p, []);
        pageMap.get(p)!.push(c.chunk_index);
      }
    }
    startCharMap.value = map;
    pageChunksMap.value = pageMap;
  } catch { /* ignore */ }
}

// ── URL chunk index ────────────────────────────────────────────────────────

watch(() => route.query.ci, (ci) => {
  console.log('[chunk] route.query.ci watch FIRED', { ci, currentChunkIdx: chunkIdx.value });
  if (ci != null) {
    const n = parseInt(ci as string);
    if (!isNaN(n) && n !== chunkIdx.value) {
      console.log('[chunk] ci from URL', n);
      // Defer to next tick so the scroll watch (defined later in setup) is active
      nextTick(() => { chunkIdx.value = n; });
    }
  }
}, { immediate: true });

// ── Edit mode ──────────────────────────────────────────────────────────────

function handleStartEdit() {
  const initialContent = content.value;
  editContent.value = initialContent;
  editError.value = "";
  editing.value = true;
  if (tabCache.value) {
    tabCache.value = { ...tabCache.value, isEditing: true, editContent: initialContent };
  }
  nextTick(() => {
    const ta = document.querySelector(".doc-edit-textarea") as HTMLTextAreaElement | null;
    if (!ta) return;
    let charPos = 0;
    if (chunkIdx.value != null) {
      const sc = startCharMap.value.get(chunkIdx.value);
      if (sc != null && sc > 0) charPos = sc;
    }
    ta.focus();
    ta.setSelectionRange(charPos, charPos);
    const lineHeight = 20;
    const linesBefore = content.value.slice(0, charPos).split("\n").length;
    ta.scrollTop = Math.max(0, (linesBefore - 5) * lineHeight);
  });
}

function handleCancelEdit() {
  editing.value = false;
  editContent.value = "";
  if (tabCache.value) {
    tabCache.value = { ...tabCache.value, isEditing: false, editContent: null };
  }
}

async function handleSave() {
  if (!kbId.value || !docId.value) return;
  saving.value = true;
  editError.value = "";
  try {
    await saveDocumentContent(kbId.value, docId.value, editContent.value);
    const { task_id } = await indexDocument({
      kb_id: kbId.value, doc_id: docId.value, doc_name: docName.value, markdown_content: editContent.value,
    });
    const r = await waitForIndex(task_id);
    await saveDocumentChunks(kbId.value, docId.value, r.chunk_count!, r.embedding_model!, r.embedding_dim!);
    content.value = editContent.value;
    editing.value = false;
    if (tabCache.value) {
      tabCache.value = {
        content: editContent.value,
        docName: docName.value,
        scrollTop: 0,
        startCharEntries: [],
        pageChunksEntries: [],
        pageAnchorPositions: [],
        cachedAt: Date.now(),
        isEditing: false,
        editContent: null,
      };
    }
  } catch (e) { editError.value = String(e); }
  saving.value = false;
}

// ── Jump to chunk ──────────────────────────────────────────────────────────

function jumpToChunk(ci: number, heading?: { text: string; pos: number }) {
  searchResults.value = null;
  window.history.replaceState({}, "", `?ci=${ci}`);
  jumpCounter.current += 1;
  scrollTarget.value = heading ? { ...heading, n: jumpCounter.current } : null;
  chunkIdx.value = ci;
  jumpTrigger.value = jumpTrigger.value + 1;
}

// ── Page jump ──────────────────────────────────────────────────────────────

function handlePageJump() {
  const realPage = Number(pageInput.value);
  if (!Number.isFinite(realPage)) return;
  const virtualPage = realPage + savedPageOffset.value;
  let targetCi = pageToAnchorChunk.value.get(virtualPage);
  if (targetCi == null) {
    for (let np = virtualPage + 1; np <= maxPage.value; np++) {
      const nc = pageToAnchorChunk.value.get(np);
      if (nc != null) { targetCi = nc; break; }
    }
  }
  if (targetCi != null) {
    pageJumpError.value = "";
    jumpToChunk(targetCi);
  } else if (hasPageData.value) {
    pageJumpError.value = `No chunks on page ${realPage}`;
  }
}

// ── Search ─────────────────────────────────────────────────────────────────

async function handleSearch(ev: KeyboardEvent) {
  if (ev.key === "Escape") { searchOpen.value = false; return; }
  if (ev.key !== "Enter" || !kbId.value || !docId.value || !searchQuery.value.trim()) return;
  searching.value = true;
  searchError.value = "";
  searchResults.value = null;
  try {
    const r = await searchDocument({
      kb_id: kbId.value, doc_id: docId.value, query: searchQuery.value.trim(),
    });
    searchResults.value = r.results;
  } catch (err) { searchError.value = String(err); }
  searching.value = false;
}

// ── Scroll position save ───────────────────────────────────────────────────

let scrollTimer: ReturnType<typeof setTimeout> | null = null;

function onScroll() {
  if (scrollTimer) return;
  scrollTimer = setTimeout(() => {
    scrollTimer = null;
    if (!kbId.value || !docId.value || !docScrollRef.value) return;
    try {
      localStorage.setItem(`skb-scroll-${kbId.value}-${docId.value}`, String(docScrollRef.value.scrollTop));
    } catch { /* ignore */ }
  }, 200);
}

onUnmounted(() => {
  if (scrollTimer) clearTimeout(scrollTimer);
});

// ── Auto-detect PDF view from route query ──────────────────────────────

watch([loading, () => route.query.view], async ([isLoading, view]) => {
  if (!isLoading && view === 'pdf' && docId.value && kbId.value) {
    await nextTick();
    await openPdf();
  }
}, { immediate: true });

// Auto-open PDF when document is loaded
watch([loading, doc], async ([isLoading, doc]) => {
  if (!isLoading && doc?.file_type === 'pdf' && !pdfOpened) {
    await nextTick();
    await openPdf();
  }
});

function onKeydown(ev: KeyboardEvent) {
  if (editing.value) return;
  const el = docScrollRef.value;
  if (!el) return;

  // Focus mode toggle
  if (ev.ctrlKey && ev.shiftKey && ev.key === "F") {
    ev.preventDefault();
    document.body.classList.toggle("skb-focus-mode");
    return;
  }

  if (ev.key === "PageUp") {
    ev.preventDefault();
    el.scrollBy({ top: -el.clientHeight * 0.85, behavior: "smooth" });
  } else if (ev.key === "PageDown") {
    ev.preventDefault();
    el.scrollBy({ top: el.clientHeight * 0.85, behavior: "smooth" });
  } else if (ev.key === "Home") {
    ev.preventDefault();
    el.scrollTo({ top: 0, behavior: "smooth" });
  } else if (ev.key === "End") {
    ev.preventDefault();
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }
}

// ── TOC initialization ─────────────────────────────────────────────────────

onMounted(() => {
  // Restore TOC state
  try { tocOpen.value = localStorage.getItem(`skb-toc-${docId.value}`) === "true"; } catch { /* */ }
  // Restore fill task
  try { fillTaskId.value = localStorage.getItem(`skb-fill-${kbId.value}-${docId.value}`); } catch { /* */ }
  document.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown);
  document.body.classList.remove("skb-focus-mode");
});

// ── Image load helper ──────────────────────────────────────────────────────

async function loadImage(name: string) {
  if (!kbId.value || !docId.value) return;
  try {
    const bytes = await readDocumentImage(kbId.value, docId.value, name);
    const blob = new Blob([new Uint8Array(bytes)]);
    imageSrcs.value = new Map(imageSrcs.value).set(name, URL.createObjectURL(blob));
  } catch { /* ignore */ }
}

// ── Image meta / VLM descriptions ───────────────────────────────────────────

const currentImageDesc = computed(() => {
  if (dialogIdx.value == null) return "";
  const name = imageNames.value[dialogIdx.value];
  return imageMeta.value[name]?.description || "";
});

async function loadImageMeta() {
  if (!kbId.value || !docId.value) return;
  try {
    const meta = await getImageMeta(kbId.value, docId.value);
    imageMeta.value = meta as Record<string, any>;
  } catch { /* ignore */ }
}

async function saveDesc() {
  if (!kbId.value || !docId.value || dialogIdx.value == null) return;
  const name = imageNames.value[dialogIdx.value];
  if (!name) return;
  descSaving.value = true;
  try {
    await saveImageDesc(kbId.value, docId.value, name, descEditText.value);
    imageMeta.value = {
      ...imageMeta.value,
      [name]: { ...(imageMeta.value[name] || {}), description: descEditText.value },
    };
    editingDesc.value = false;
  } catch { /* ignore */ }
  descSaving.value = false;
}

async function handleReAnalyze() {
  if (!kbId.value || !docId.value || dialogIdx.value == null) return;
  const name = imageNames.value[dialogIdx.value];
  if (!name) return;
  vlmLoading.value = true;
  try {
    const { pythonFetch } = await import("@/services/pythonClient");
    const r = await pythonFetch<any>("/images/describe", {
      method: "POST",
      body: JSON.stringify({ kb_id: kbId.value, doc_id: docId.value, filename: name }),
    });
    if (r.description) {
      descEditText.value = r.description;
      await saveImageDesc(kbId.value, docId.value, name, r.description);
      imageMeta.value = {
        ...imageMeta.value,
        [name]: { ...(imageMeta.value[name] || {}), description: r.description },
      };
    }
  } catch { /* ignore */ }
  vlmLoading.value = false;
}

// ── VLM fill ───────────────────────────────────────────────────────────────

const fillDialogOpen = ref(false);
const fillError = ref<string | null>(null);
let fillPollInterval: ReturnType<typeof setInterval> | null = null;

function stopFillPolling() {
  if (fillPollInterval) { clearInterval(fillPollInterval); fillPollInterval = null; }
}

function startFillPolling(tid: string) {
  stopFillPolling();
  fillPollInterval = setInterval(async () => {
    try {
      const p = await pollFillProgress(tid);
      fillProgress.value = {
        current: p.current, total: p.total, currentName: p.current_name || "",
        message: p.message || "", done: p.done, filled: p.filled, failed: p.failed,
        failed_details: p.failed_details,
      };
      if (p.done) {
        stopFillPolling();
        fillTaskId.value = null;
        try { localStorage.removeItem(`skb-fill-${kbId.value}-${docId.value}`); } catch { /* */ }
      }
    } catch { /* ignore */ }
  }, 800);
}

async function handleFillClick() {
  fillDialogOpen.value = true;
  if (fillTaskId.value && fillProgress.value && !fillProgress.value.done) {
    if (!fillPollInterval) startFillPolling(fillTaskId.value);
    return;
  }
  fillError.value = null;
  try {
    const r = await fillMissingImages(kbId.value, docId.value);
    if (r.done) {
      fillProgress.value = {
        current: 0, total: 0, currentName: "", message: r.message || "All images have valid descriptions",
        done: true,
      };
      fillTaskId.value = null;
      try { localStorage.removeItem(`skb-fill-${kbId.value}-${docId.value}`); } catch { /* */ }
    } else {
      fillTaskId.value = r.task_id;
      try { localStorage.setItem(`skb-fill-${kbId.value}-${docId.value}`, r.task_id); } catch { /* */ }
      startFillPolling(r.task_id);
    }
  } catch (e) { fillError.value = String(e); }
}

function closeFillDialog() {
  fillDialogOpen.value = false;
  // Don't stop polling — task continues in background
}

// Re-attach polling if dialog reopens
watch(fillDialogOpen, (open) => {
  if (open && fillTaskId.value && fillProgress.value && !fillProgress.value.done && !fillPollInterval) {
    startFillPolling(fillTaskId.value);
  }
});

const fillPct = computed(() => {
  if (!fillProgress.value || fillProgress.value.total <= 0) return 0;
  return Math.round((fillProgress.value.current / fillProgress.value.total) * 100);
});

// Resume polling on mount
onMounted(() => {
  if (fillTaskId.value && !fillPollInterval) {
    pollFillProgress(fillTaskId.value).then((p) => {
      if (!p.done) {
        fillProgress.value = {
          current: p.current, total: p.total, currentName: p.current_name || "",
          message: p.message || "", done: p.done, filled: p.filled, failed: p.failed,
          failed_details: p.failed_details,
        };
        startFillPolling(fillTaskId.value!);
      } else {
        fillProgress.value = {
          current: p.total, total: p.total, currentName: "", message: p.message || "Done",
          done: true, filled: p.filled, failed: p.failed,
          failed_details: p.failed_details,
        };
        fillTaskId.value = null;
        try { localStorage.removeItem(`skb-fill-${kbId.value}-${docId.value}`); } catch { /* */ }
      }
    }).catch(() => {
      fillTaskId.value = null;
      try { localStorage.removeItem(`skb-fill-${kbId.value}-${docId.value}`); } catch { /* */ }
    });
  }
});

onUnmounted(() => stopFillPolling());

// ── Anchored content: inject <a id="page-N"> anchors for scroll positioning ─
// Anchors are sorted high->low so injection preserves earlier positions.
// Skip positions inside math blocks ($$...$$ or $...$) to avoid breaking LaTeX.

function findMathRanges(content: string): [number, number][] {
  const ranges: [number, number][] = [];
  // Display math $$...$$
  let i = 0;
  while (i < content.length) {
    const dd = content.indexOf('$$', i);
    if (dd === -1) break;
    const end = content.indexOf('$$', dd + 2);
    if (end === -1) break;
    ranges.push([dd, end + 2]);
    i = end + 2;
  }
  // Inline math $...$ (skip $$)
  i = 0;
  while (i < content.length) {
    const d = content.indexOf('$', i);
    if (d === -1) break;
    if (content[d + 1] === '$') { i = d + 2; continue; }
    const end = content.indexOf('$', d + 1);
    if (end === -1) break;
    ranges.push([d, end + 1]);
    i = end + 1;
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function isInsideMath(pos: number, ranges: [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
    if (pos < start) return false;
  }
  return false;
}

const anchoredContent = computed(() => {
  if (!content.value || pageAnchorPositions.value.length === 0) return content.value;
  const mathRanges = findMathRanges(content.value);
  let result = content.value;
  for (const { page, startChar } of pageAnchorPositions.value) {
    if (startChar < 0 || startChar > result.length) continue;
    if (isInsideMath(startChar, mathRanges)) continue;
    const anchor = `<a id="page-${page}" data-page="${page}"></a>`;
    result = result.slice(0, startChar) + anchor + result.slice(startChar);
  }
  return result;
});

// ── Section anchor injection helper ────────────────────────────────────────

/** Inject page anchors into a section string, skipping math blocks. */
function injectAnchorsIntoSection(
  sec: string, secStart: number, secEnd: number,
  positions: { page: number; startChar: number }[],
): string {
  const mathRanges = findMathRanges(sec);
  let result = sec;
  for (const { page, startChar } of positions) {
    if (startChar >= secStart && startChar < secEnd) {
      const relPos = startChar - secStart;
      if (isInsideMath(relPos, mathRanges)) continue;
      result = result.slice(0, relPos) +
        '<a id="page-' + page + '" data-page="' + page + '"></a>' +
        result.slice(relPos);
    }
  }
  return result;
}

/** Linear page list from minPage to maxPage for the TOC page strip. */
const tocPages = computed(() => {
  const pages: number[] = [];
  for (let p = minPage.value; p <= maxPage.value; p++) pages.push(p);
  return pages;
});

/** Jump to the first chunk found on a page. */
function jumpToPage(p: number) {
  let targetCi = pageToAnchorChunk.value.get(p);
  if (targetCi == null) {
    for (let np = p + 1; np <= maxPage.value; np++) {
      const nc = pageToAnchorChunk.value.get(np);
      if (nc != null) { targetCi = nc; break; }
    }
  }
  if (targetCi != null) jumpToChunk(targetCi);
}

// ── DocView sub-component logic ────────────────────────────────────────────

const sections = computed(() => splitSections(content.value));
const sectionOffsets = computed(() => buildSectionOffsets(content.value, sections.value));

const chunkEntries = computed(() => {
  const sorted = [...startCharMap.value.entries()].sort((a, b) => a[0] - b[0]);
  return sorted.map(([idx, start], i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1][1] : content.value.length;
    return { chunkIndex: idx, startChar: start, endChar: end };
  });
});

const charToSection = computed(() => {
  return (pos: number): number => {
    for (let i = sectionOffsets.value.length - 1; i >= 0; i--) {
      if (pos >= sectionOffsets.value[i]) return i;
    }
    return 0;
  };
});

const sectionEstimatedTops = computed(() => {
  const tops: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < sections.value.length; i++) {
    tops.push(cumulative);
    const sec = sections.value[i];
    const displayMathCount = Math.floor(((sec.match(/\$\$/g) || []).length) / 2);
    const textLines = Math.ceil(sec.length / 80);
    const estimatedHeight = Math.max(200, textLines * 22 + displayMathCount * 50);
    cumulative += estimatedHeight;
  }
  return tops;
});

const chunkSection = computed(() => {
  const map = new Map<number, number>();
  for (const e of chunkEntries.value) {
    map.set(e.chunkIndex, findSectionForChar(sectionOffsets.value, e.startChar));
  }
  return map;
});

const EAGER = 3;
const WINDOW = 12;

const targetSecIdx = computed(() =>
  chunkIdx.value != null ? (chunkSection.value.get(chunkIdx.value) ?? null) : null,
);

const rendered = ref<Set<number>>(new Set<number>());
// Initialize eager sections
(function initRendered() {
  const s = new Set<number>();
  for (let i = 0; i < Math.min(EAGER, sections.value.length); i++) s.add(i);
  rendered.value = s;
})();

// Ensure target section window is rendered
watch(targetSecIdx, (newIdx) => {
  if (newIdx == null) return;
  rendered.value = new Set([
    ...rendered.value,
    ...Array.from({ length: 7 }, (_, i) => Math.max(0, newIdx - 3 + i)).filter((i) => i < sections.value.length),
  ]);
});

// IntersectionObserver for lazy loading
const sentinelRefs = new Map<number, HTMLElement>();
let observer: IntersectionObserver | null = null;

function setupObserver() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    const next = new Set(rendered.value);
    let changed = false;
    for (const e of entries) {
      const idx = Number((e.target as HTMLElement).dataset.sectionIdx);
      if (!isNaN(idx) && e.isIntersecting && !next.has(idx)) {
        next.add(idx);
        changed = true;
      }
    }
    if (changed) rendered.value = next;
  }, { root: docScrollRef.value, rootMargin: "5000px" });
  sentinelRefs.forEach((el) => observer?.observe(el));
}

watch([docScrollRef, sections], () => {
  nextTick(() => setupObserver());
}, { immediate: true });

onUnmounted(() => observer?.disconnect());

function sentinelRef(idx: number) {
  return (el: any) => {
    if (el) {
      sentinelRefs.set(idx, el as HTMLElement);
      observer?.observe(el as HTMLElement);
    } else {
      const old = sentinelRefs.get(idx);
      if (old) observer?.unobserve(old);
      sentinelRefs.delete(idx);
    }
  };
}

// Track active heading for TOC
let headingObserverTimer: ReturnType<typeof setTimeout> | null = null;

function trackActiveHeading() {
  if (!docScrollRef.value) return;
  headingObserverTimer = null;
  const allHeadings = docScrollRef.value.querySelectorAll("h1[id], h2[id], h3[id], h4[id]") as NodeListOf<HTMLElement>;
  if (allHeadings.length === 0) { activeHeadingText.value = null; return; }

  const scrollTop = docScrollRef.value.getBoundingClientRect().top + 60;
  let activeText: string | null = null;
  for (const el of allHeadings) {
    if (el.getBoundingClientRect().top <= scrollTop) {
      activeText = (el.textContent ?? "").trim();
    } else {
      break;
    }
  }
  activeHeadingText.value = activeText;
}

function onDocScroll() {
  onScroll();
  if (!headingObserverTimer) headingObserverTimer = setTimeout(trackActiveHeading, 80);
}

// ── PDF jump helpers ──
function waitForPageWrapper(pageNum: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (document.querySelector(`[data-page="${pageNum}"]`)) { resolve(); return; }
      if (Date.now() - start > timeoutMs) { resolve(); return; }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}
function highlightPdfPage(pageNum: number) {
  const el = document.querySelector(`[data-page="${pageNum}"]`) as HTMLElement | null;
  if (!el) return;
  el.style.boxShadow = '0 0 0 3px #f59e0b';
  el.style.transition = 'box-shadow 0.5s ease';
  setTimeout(() => { el.style.boxShadow = ''; }, 2500);
}
function waitForSectionRender(si: number, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const el = document.querySelector(`[data-section-idx="${si}"]`) as HTMLElement | null;
      const hasMarkdown = el?.querySelector('.markdown-renderer');
      // Must contain actual rendered markdown, not just the placeholder div
      if (el && hasMarkdown) {
        console.log('[chunk] waitForSectionRender found .markdown-renderer after', Date.now() - start, 'ms');
        resolve(); return;
      }
      if (Date.now() - start > timeoutMs) {
        console.log('[chunk] waitForSectionRender TIMEOUT after', timeoutMs, 'ms - sectionEl exists?', !!el, 'hasMarkdown?', !!hasMarkdown, 'offsetHeight', el?.offsetHeight);
        resolve(); return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

// Scroll to target chunk
watch([chunkIdx, jumpTrigger, scrollTarget], async () => {
  console.log('[chunk] watch FIRED', { chunkIdx: chunkIdx.value, jumpTrigger: jumpTrigger.value, scrollTarget: scrollTarget.value });
  if (chunkIdx.value == null) { console.log('[chunk] chunkIdx is null, returning'); return; }

  // Guard: wait for startCharMap to be populated (may still be loading)
  if (startCharMap.value.size === 0) {
    console.log('[chunk] startCharMap empty, polling until loaded...');
    // Poll up to 10s for content to load
    const deadline = Date.now() + 10000;
    while (startCharMap.value.size === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (startCharMap.value.size === 0) {
      console.log('[chunk] startCharMap still empty after 10s, aborting jump');
      return;
    }
    console.log('[chunk] startCharMap loaded with', startCharMap.value.size, 'entries after', (10000 - (deadline - Date.now())), 'ms');
  }

  await nextTick();

  const container = docScrollRef.value;
  if (!container) { console.log('[chunk] no container'); return; }

  const ci = chunkIdx.value;
  console.log('[chunk] jump triggered', {
    ci,
    contentLen: content.value?.length,
    startCharMapSize: startCharMap.value.size,
    pageChunksMapSize: pageChunksMap.value.size,
    sectionsLen: sections.value.length,
    viewMode: viewMode.value,
    pdfOpened,
  });

  // ── PDF view: jump to page (MUST run before markdown logic) ──
  if (viewMode.value === 'pdf') {
    let pageNum: number | null = null;
    for (const [page, chunkIndices] of pageChunksMap.value) {
      if (chunkIndices.includes(ci)) { pageNum = page; break; }
    }
    console.log('[chunk] PDF mode - pageNum', pageNum);
    if (pageNum != null) {
      if (!pdfOpened) {
        console.log('[chunk] PDF not opened, calling openPdf');
        await openPdf();
        await nextTick();
        await waitForPageWrapper(pageNum);
      }
      docStore.setPage(pageNum);
      highlightPdfPage(pageNum);
      return;
    }
    return; // page not found in PDF
  }

  // ── Markdown view: scroll to chunk ──
  if (!scrollTarget.value) {
    // ── Debug: dump startCharMap entries around target ci ──
    console.log('[chunk] startCharMap lookup', {
      ci,
      'startCharMap.get(ci)': startCharMap.value.get(ci),
      'startCharMap keys (first 10)': [...startCharMap.value.keys()].slice(0, 10),
      'startCharMap keys (last 10)': [...startCharMap.value.keys()].slice(-10),
      'startCharMap total entries': startCharMap.value.size,
    });

    let pageNum: number | null = null;
    for (const { page, startChar } of pageAnchorPositions.value) {
      const sc = startCharMap.value.get(ci);
      if (sc != null && sc === startChar) { pageNum = page; break; }
    }
    if (pageNum == null) {
      for (const [page, chunkIndices] of pageChunksMap.value) {
        if (chunkIndices.includes(ci)) { pageNum = page; break; }
      }
    }
    console.log('[chunk] pageNum from maps', pageNum);

    // Scroll to section containing this chunk
    const sc = startCharMap.value.get(ci);
    console.log('[chunk] sc (startChar for chunk)', { ci, sc, pageNum });

    if (sc != null) {
      const si = charToSection.value(sc);
      console.log('[chunk] section index', {
        si,
        'sectionOffsets[si]': sectionOffsets.value[si],
        'sectionOffsets (first 5)': sectionOffsets.value.slice(0, 5),
        'sectionOffsets (last 5)': sectionOffsets.value.slice(-5),
        'sections count': sections.value.length,
        'section length': sections.value[si]?.length ?? 'N/A',
        'section first 80 chars': sections.value[si]?.slice(0, 80) ?? 'N/A',
      });

      // Ensure section is rendered
      rendered.value = new Set([
        ...rendered.value,
        ...Array.from({ length: 2 * WINDOW + 1 }, (_, i) => Math.max(0, si - WINDOW + i)).filter((i) => i < sections.value.length),
      ]);
      console.log('[chunk] rendered set size', rendered.value.size, 'has si?', rendered.value.has(si));

      // Wait for section to actually render
      await nextTick();
      const renderStart = Date.now();
      await waitForSectionRender(si);
      console.log('[chunk] waitForSectionRender took', Date.now() - renderStart, 'ms');

      const sectionEl = container.querySelector(`[data-section-idx="${si}"]`) as HTMLElement | null;
      console.log('[chunk] sectionEl found?', !!sectionEl, 'data-section-idx', si,
        'sectionEl.offsetTop', sectionEl?.offsetTop,
        'sectionEl.offsetHeight', sectionEl?.offsetHeight,
        'container.scrollTop', container.scrollTop);
      if (sectionEl) {
        // Find the chunk's end position (next chunk's startChar, or end of content)
        const chunkEnd = (() => {
          const sorted = [...startCharMap.value.entries()].sort((a, b) => a[1] - b[1]);
          for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i][0] === ci) return sorted[i + 1][1];
          }
          return content.value.length;
        })();
        const siEnd = charToSection.value(chunkEnd);

        // Find block-level elements within the chunk's character range
        const selector = '.markdown-renderer > h1, .markdown-renderer > h2, .markdown-renderer > h3, .markdown-renderer > h4, .markdown-renderer > p, .markdown-renderer > pre, .markdown-renderer > blockquote, .markdown-renderer > ul, .markdown-renderer > ol, .markdown-renderer > table';
        const allBlocks = sectionEl.querySelectorAll(selector);
        const highlightEls: HTMLElement[] = [];

        // If chunk spans multiple sections, also gather blocks from subsequent sections
        const gatherBlocks = (secIdx: number) => {
          const sel = container.querySelector(`[data-section-idx="${secIdx}"]`) as HTMLElement | null;
          if (sel) {
            sel.querySelectorAll(selector).forEach(b => highlightEls.push(b as HTMLElement));
          }
        };

        for (let s = si; s <= siEnd; s++) {
          if (s === si) {
            // Start section: highlight blocks from the target block onward
            const blocks = Array.from(sectionEl.querySelectorAll(selector));
            const secStart = sectionOffsets.value[si] ?? 0;
            const relPos = sc - secStart;
            const secLen = (sections.value[si] || '').length;
            const ratio = secLen > 0 ? relPos / secLen : 0;
            const startIdx = blocks.length > 0 ? Math.min(Math.floor(ratio * blocks.length), blocks.length - 1) : 0;
            for (let i = startIdx; i < blocks.length; i++) highlightEls.push(blocks[i] as HTMLElement);
          } else {
            gatherBlocks(s);
          }
        }

        console.log('[chunk] highlight', { ci, sc, chunkEnd, si, siEnd, highlightCount: highlightEls.length });

        // Scroll to the first highlighted element
        const targetEl = highlightEls[0] || sectionEl;
        targetEl.scrollIntoView({ block: "start", behavior: "instant" });

        // Highlight all blocks in the chunk range
        for (const el of highlightEls) {
          el.style.backgroundColor = "#fef3c7";
          el.style.transition = "background-color 0.8s ease";
        }
        setTimeout(() => {
          for (const el of highlightEls) { el.style.backgroundColor = ""; }
        }, 2500);

        // Settle: re-scroll after layout stabilizes
        let settleFrames = 0;
        const settleTarget = highlightEls[0] || sectionEl;
        const settle = () => {
          if (++settleFrames <= 3) {
            settleTarget.scrollIntoView({ block: "start", behavior: "instant" });
            requestAnimationFrame(settle);
          }
        };
        requestAnimationFrame(settle);
        return;
      }

      // Fallback: estimated position when DOM element not found
      if (sectionEstimatedTops.value[si] != null) {
        container.scrollTop = sectionEstimatedTops.value[si];
      }
      return;
    }
  }

  // ── TOC heading click: use heading text matching ──
  const secIdx = scrollTarget.value ? charToSection.value(scrollTarget.value.pos) : null;
  if (secIdx == null) return;

  {
    const cont = docScrollRef.value;
    if (cont && sectionEstimatedTops.value[secIdx] != null) {
      cont.scrollTop = sectionEstimatedTops.value[secIdx];
    }
  }

  rendered.value = new Set([
    ...rendered.value,
    ...Array.from({ length: 2 * WINDOW + 1 }, (_, i) => Math.max(0, secIdx - WINDOW + i)).filter((i) => i < sections.value.length),
  ]);

  let attempts = 0;
  const tryHeading = () => {
    const cont = docScrollRef.value;
    if (!cont) return;

    const sectionEl = cont.querySelector(`[data-section-idx="${secIdx}"]`) as HTMLElement | null;
    if (!sectionEl || sectionEl.offsetHeight < 50) {
      if (++attempts < 10) { requestAnimationFrame(tryHeading); }
      return;
    }

    const stripMd = (s: string) => s.replace(/\s+/g, " ").replace(/[$*_`~]/g, "").trim();
    const want = stripMd(scrollTarget.value!.text);
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
      targetEl.style.backgroundColor = "";
    }, 2500);
  };
  requestAnimationFrame(tryHeading);
});

function onPageOffsetInput(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value);
  if (!isNaN(v) && v >= 0) {
    savePageOffset(v > 0 ? v - 1 : 0);
  }
}

async function openImageDialog(i: number) {
  const name = imageNames.value[i];
  if (!imageSrcs.value.has(name)) await loadImage(name);
  dialogIdx.value = i;
  loadImageMeta();
}

// ── Image dialog navigation ────────────────────────────────────────────────

function prevImage() {
  if (dialogIdx.value != null && dialogIdx.value > 0) {
    dialogIdx.value = dialogIdx.value - 1;
  }
}

function nextImage() {
  if (dialogIdx.value != null && dialogIdx.value < imageNames.value.length - 1) {
    dialogIdx.value = dialogIdx.value + 1;
  }
}
</script>

<template>
  <div class="doc-preview" :style="{ height: '100%' }">
    <!-- Loading -->
    <div v-if="loading" class="center-state">
      <div class="spinner" />
      <p class="muted-text">Loading document...</p>
    </div>

    <!-- No markdown -->
    <div v-else-if="!mdAvailable" class="center-state max-w-md mx-auto">
      <AlertTriangle :size="40" class="text-amber-500" />
      <div>
        <p class="font-medium text-sm">This document has no parsed content.</p>
        <p class="text-xs muted-text mt-1">It may be a parent document whose parts were indexed, or the parse has not completed.</p>
      </div>
      <div class="bg-muted rounded-lg p-3 w-full text-left">
        <p class="text-[10px] muted-text font-mono break-all">KB: {{ kbId }}</p>
        <p class="text-[10px] muted-text font-mono break-all">Doc: {{ docId }}</p>
      </div>
      <button @click="router.push(`/kb/${kbId}`)" class="px-3 py-1.5 border rounded-md text-xs hover:bg-muted">
        &larr; Back to knowledge base
      </button>
    </div>

    <!-- Main content -->
    <template v-else>
      <!-- Header -->
      <div class="doc-header">
        <!-- Left: back + search + edit -->
        <div class="header-actions-left">
          <button @click="router.back()" class="icon-btn" title="Back">
            <ArrowLeft :size="14" />
          </button>
          <template v-if="editing">
            <button @click="handleSave" :disabled="saving" class="icon-btn text-green-600" title="Save">
              <div v-if="saving" class="spinner-sm" />
              <Check v-else :size="14" />
            </button>
            <button @click="handleCancelEdit" :disabled="saving" class="icon-btn text-red-500" title="Cancel">
              <X :size="14" />
            </button>
          </template>
          <template v-else>
            <button
              @click="searchOpen = !searchOpen"
              :class="['icon-btn', searchOpen ? 'active' : '']"
              title="Search"
            >
              <Search :size="14" />
            </button>
            <button @click="handleStartEdit" class="icon-btn" title="Edit markdown">
              <Pencil :size="14" />
            </button>
          </template>
        </div>

        <!-- Center: doc name -->
        <div class="header-center">
          <FileText :size="14" class="text-primary shrink-0" />
          <h2 class="doc-title">{{ docName }}</h2>
        </div>

        <!-- Right: TOC + images + PDF toggle -->
        <div class="header-actions-right" style="width: auto; gap: 2px">
          <template v-if="!editing">
            <button
              @click="openPdf"
              :class="['icon-btn', viewMode === 'pdf' ? 'active' : '']"
              title="View PDF"
            >
              <FileText :size="14" />
            </button>
            <button
              v-if="viewMode === 'pdf'"
              @click="viewMode = 'markdown'"
              class="icon-btn"
              title="View Markdown"
            >
              <X :size="14" />
            </button>
            <button
              @click="wrappedSetTocOpen(!tocOpen)"
              :class="['icon-btn', tocOpen ? 'active' : '']"
              title="Table of contents"
            >
              <List :size="14" />
            </button>
            <button
              v-if="imageNames.length > 0"
              @click="imagesOpen = !imagesOpen"
              :class="['icon-btn', imagesOpen ? 'active' : '']"
              title="Images"
            >
              <ImageIcon :size="14" />
            </button>
          </template>
        </div>
      </div>

      <!-- Edit error -->
      <div v-if="editError" class="error-banner">{{ editError }}</div>
      <p v-if="editing" class="edit-hint">Edit the markdown content below. Save to re-index.</p>

      <!-- Edit textarea -->
      <textarea
        v-if="editing"
        v-model="editContent"
        class="doc-edit-textarea"
        :disabled="saving"
      />

      <!-- PDF view -->
      <PdfViewport
        v-else-if="viewMode === 'pdf' && !editing"
        style="flex: 1; min-height: 0;"
      />

      <!-- DocView -->
      <div
        v-else
        ref="docScrollRef"
        id="doc-preview-scroll"
        class="doc-scroll"
        @scroll="onDocScroll"
      >
        <div class="prose-container">
          <template v-if="sections.length <= 1">
            <div data-section-idx="0">
              <MarkdownRenderer :content="anchoredContent" />
            </div>
          </template>
          <template v-else>
            <div
              v-for="(sec, i) in sections"
              :key="i"
              :data-section-idx="i"
            >
              <template v-if="i < EAGER || rendered.has(i)">
                <MarkdownRenderer :content="injectAnchorsIntoSection(sec, sectionOffsets[i], sectionOffsets[i] + sec.length, pageAnchorPositions)" />
              </template>
              <template v-else>
                <div :ref="sentinelRef(i)" :data-section-idx="i" style="height: 1px" />
                <div :style="{ height: Math.max(200, (sectionEstimatedTops[i + 1] ?? 0) - sectionEstimatedTops[i] || 200) + 'px' }" />
              </template>
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- ── Search Dialog ── -->
    <Teleport to="body">
      <div v-if="searchOpen" class="search-overlay" @click="searchOpen = false">
        <div class="search-dialog" @click.stop>
          <div class="search-input-row">
            <Search :size="16" class="text-muted shrink-0" />
            <input
              v-model="searchQuery"
              type="text"
              autofocus
              @keydown="handleSearch"
              placeholder="Search in document..."
              class="search-input"
            />
            <button v-if="searchQuery" @click="searchQuery = ''; searchResults = null" class="icon-btn">
              <XCircle :size="16" />
            </button>
            <button @click="searchOpen = false" class="icon-btn">
              <X :size="16" />
            </button>
          </div>
          <div v-if="searching" class="search-loading">
            <div class="spinner" />
          </div>
          <p v-if="searchError" class="search-error">{{ searchError }}</p>
          <div v-if="searchResults" class="search-results">
            <p v-if="searchResults.length === 0" class="no-results">No results found.</p>
            <button
              v-for="(r, i) in searchResults"
              :key="i"
              @click="searchResults = null; searchQuery = ''; searchOpen = false; router.push(`/kb/${kbId}/documents/${docId}?ci=${r.metadata?.chunk_index}`)"
              class="search-result-item"
            >
              <div class="search-result-meta">
                <span class="text-xs font-mono muted-text">
                  Chunk {{ r.metadata?.chunk_index ?? "?" }}{{ (r.metadata?.page ?? 0) > 0 ? ` · Page ${r.metadata.page}` : "" }}
                </span>
                <span class="text-xs font-mono text-primary">{{ (r.score * 100).toFixed(0) }}%</span>
              </div>
              <div class="search-result-preview">
                {{ r.content.slice(0, 400) }}
              </div>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ── TOC Panel ── -->
    <Teleport to="body">
      <div v-if="!editing && tocOpen" class="toc-panel">
        <div class="toc-header">
          <span class="toc-title">Contents</span>
          <div class="toc-header-actions">
            <button @click="pageSettingsOpen = true" class="icon-btn" title="Page settings">
              <Settings :size="12" />
            </button>
            <button @click="wrappedSetTocOpen(false)" class="icon-btn">
              <X :size="14" />
            </button>
          </div>
        </div>
        <div class="toc-body">
          <div class="toc-headings">
            <p v-if="headings.length === 0" class="text-xs muted-text p-2">No headings found.</p>
            <button
              v-for="(h, i) in headings"
              :key="i"
              @click="h.chunkIndex != null && jumpToChunk(h.chunkIndex, { text: h.text, pos: h.charOffset })"
              :class="['toc-heading-btn', { active: activeHeadingIndex === i }]"
              :style="{ paddingLeft: `${4 + (h.level - 1) * 10}px` }"
            >
              {{ h.text }}
            </button>
          </div>
          <!-- Page strip -->
          <div v-if="hasPageData && maxPage > 0" class="toc-page-strip">
            <button
              v-for="p in tocPages"
              :key="p"
              @click="jumpToPage(p)"
              class="toc-page-btn"
            >
              {{ (p - savedPageOffset) <= 0 ? toRoman(p) : String(p - savedPageOffset) }}
            </button>
          </div>
        </div>
        <div class="toc-footer">
          <div class="flex gap-1">
            <input
              v-model="pageInput"
              type="number"
              :min="minPage"
              :max="maxPage"
              @keydown.enter="handlePageJump"
              :disabled="!hasPageData"
              :placeholder="hasPageData ? 'Page #' : '-'"
              class="page-input"
            />
            <button
              @click="handlePageJump"
              :disabled="!hasPageData || !pageInput"
              class="icon-btn"
            >
              <ChevronRight :size="12" />
            </button>
          </div>
          <p v-if="pageJumpError" class="page-jump-error">{{ pageJumpError }}</p>
        </div>
      </div>
    </Teleport>

    <!-- ── Images Panel ── -->
    <Teleport to="body">
      <div v-if="!editing && imagesOpen" class="images-panel">
        <div class="images-header">
          <span class="images-title">Images ({{ imageNames.length }})</span>
          <div class="images-header-actions">
            <!-- Fill missing button -->
            <button
              @click="handleFillClick"
              :class="['icon-btn', { 'text-amber-500': fillTaskId && fillProgress && !fillProgress.done }]"
              :title="fillTaskId && fillProgress && !fillProgress.done ? `Filling... ${fillProgress.current}/${fillProgress.total}` : 'Fill missing image descriptions with VLM'"
            >
              <div v-if="fillTaskId && fillProgress && !fillProgress.done" class="spinner-sm" />
              <RefreshCw v-else :size="14" />
            </button>
            <button @click="galleryMode = galleryMode === 'grid' ? 'list' : 'grid'" class="icon-btn" title="Toggle view">
              <Rows3 v-if="galleryMode === 'grid'" :size="12" />
              <LayoutGrid v-else :size="12" />
            </button>
            <button @click="imagesOpen = false" class="icon-btn">
              <X :size="14" />
            </button>
          </div>
        </div>
        <div :class="['images-body', galleryMode === 'grid' ? 'grid' : 'list']">
          <template v-for="(name, i) in imageNames" :key="name">
            <!-- Grid mode -->
            <button
              v-if="galleryMode === 'grid'"
              @click="openImageDialog(i)"
              class="image-thumb-grid"
            >
              <img v-if="imageSrcs.has(name)" :src="imageSrcs.get(name)" :alt="name" class="image-thumb-img" />
              <span v-else class="image-thumb-placeholder">Load</span>
            </button>
            <!-- List mode -->
            <button
              v-else
              @click="openImageDialog(i)"
              class="image-thumb-list"
            >
              <div class="image-thumb-list-preview">
                <img v-if="imageSrcs.has(name)" :src="imageSrcs.get(name)" :alt="name" class="image-thumb-img" />
                <ImageIcon v-else :size="12" class="text-muted/50" />
              </div>
              <span class="text-xs truncate flex-1">{{ name }}</span>
            </button>
          </template>
        </div>
      </div>
    </Teleport>

    <!-- ── Page Settings Dialog ── -->
    <Teleport to="body">
      <div v-if="pageSettingsOpen" class="dialog-overlay" @click="pageSettingsOpen = false">
        <div class="dialog-box" @click.stop>
          <h3 class="dialog-title">Page Settings</h3>
          <div class="dialog-body">
            <div class="flex items-center justify-between">
              <span class="text-xs">Page Numbering</span>
              <button
                @click="pageMode = pageMode === 'real' ? 'virtual' : 'real'"
                :class="['toggle-btn', { active: pageMode === 'real' }]"
              >
                {{ pageMode === 'real' ? 'Real' : 'Virtual' }}
              </button>
            </div>
            <p class="text-[10px] muted-text">
              {{ pageMode === 'real' ? 'Show actual page numbers from the PDF' : 'Show virtual page numbers starting from 1' }}
            </p>
            <div class="flex items-center gap-2">
              <span class="text-xs shrink-0">Virtual page</span>
              <input
                type="number"
                :min="0"
                :max="maxPage"
                :value="savedPageOffset > 0 ? savedPageOffset + 1 : 0"
                @input="onPageOffsetInput"
                class="page-offset-input"
              />
              <span class="text-xs">= Real page 1</span>
            </div>
          </div>
          <div class="dialog-footer">
            <button @click="pageSettingsOpen = false" class="btn-secondary">Cancel</button>
            <button @click="pageSettingsOpen = false" class="btn-primary">Done</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ── Fill Missing Dialog ── -->
    <Teleport to="body">
      <div v-if="fillDialogOpen" class="dialog-overlay" @click="closeFillDialog">
        <div class="dialog-box fill-dialog" @click.stop>
          <h3 class="dialog-title">Fill Missing Image Descriptions</h3>
          <div v-if="fillError" class="dialog-body">
            <p class="text-sm text-red-500">Error: {{ fillError }}</p>
            <button @click="fillDialogOpen = false; fillError = null" class="btn-primary w-full mt-2">Close</button>
          </div>
          <div v-else-if="fillProgress?.done" class="dialog-body">
            <div class="flex items-center gap-2 text-sm text-green-600">
              <Check :size="16" />
              <span>{{ fillProgress.message }}</span>
            </div>
            <p v-if="fillProgress.filled != null" class="text-xs muted-text mt-1">
              {{ fillProgress.filled }} filled{{ fillProgress.failed ? `, ${fillProgress.failed} failed` : "" }}
            </p>
            <div v-if="fillProgress.failed_details?.length" class="failed-details">
              <div v-for="(fd, i) in fillProgress.failed_details" :key="i" class="failed-item">
                <p class="font-mono text-red-600 truncate text-xs">{{ fd.name }}</p>
                <p class="muted-text truncate text-xs">{{ fd.error }}</p>
              </div>
            </div>
            <button @click="fillDialogOpen = false; fillTaskId = null; fillProgress = null" class="btn-primary w-full mt-2">Done</button>
          </div>
          <div v-else-if="fillProgress" class="dialog-body">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: fillPct + '%' }" />
            </div>
            <p class="text-xs muted-text text-center mt-2">
              {{ fillProgress.current }}/{{ fillProgress.total }} — {{ fillProgress.currentName || "..." }}
            </p>
            <p v-if="fillProgress.message" class="text-xs muted-text text-center">{{ fillProgress.message }}</p>
            <p class="text-xs muted-text text-center italic mt-1">You can close this dialog — the task continues in background.</p>
          </div>
          <div v-else class="dialog-body center-state py-4">
            <div class="spinner" />
            <span class="text-sm muted-text">Starting...</span>
          </div>
          <button
            v-if="!fillProgress?.done && fillProgress"
            @click="closeFillDialog"
            class="btn-secondary w-full mt-2"
          >
            Close (continue in background)
          </button>
        </div>
      </div>
    </Teleport>

    <!-- ── Image Dialog ── -->
    <Teleport to="body">
      <div v-if="dialogIdx != null && kbId && docId" class="image-dialog-overlay" @click="dialogIdx = null">
        <div class="image-dialog" @click.stop>
          <button @click="dialogIdx = null" class="image-dialog-close">
            <X :size="20" />
          </button>
          <button
            v-if="dialogIdx > 0"
            @click="prevImage"
            class="image-dialog-nav left"
          >
            &lsaquo;
          </button>
          <button
            v-if="dialogIdx < imageNames.length - 1"
            @click="nextImage"
            class="image-dialog-nav right"
          >
            &rsaquo;
          </button>
          <div class="image-dialog-body">
            <!-- Image area -->
            <div class="image-dialog-image-area">
              <img
                v-if="imageSrcs.has(imageNames[dialogIdx])"
                :src="imageSrcs.get(imageNames[dialogIdx])"
                :alt="imageNames[dialogIdx]"
                class="image-dialog-img"
              />
              <div v-else class="image-dialog-loading">
                <div class="spinner" />
              </div>
              <div class="image-dialog-meta-bar">
                <span class="font-medium text-sm truncate">{{ imageNames[dialogIdx] }}</span>
                <span class="text-xs muted-text shrink-0">{{ dialogIdx + 1 }} / {{ imageNames.length }}</span>
              </div>
            </div>
            <!-- Info panel -->
            <div class="image-dialog-info-panel">
              <h3 class="image-dialog-panel-title" :title="imageNames[dialogIdx]">{{ imageNames[dialogIdx] }}</h3>
              <p class="text-xs text-muted-foreground mt-1 text-center">{{ dialogIdx + 1 }} / {{ imageNames.length }}</p>
              <div class="image-desc-section">
                <div class="image-desc-header">
                  <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Description</span>
                  <div class="flex gap-1">
                    <button
                      @click="handleReAnalyze"
                      :disabled="vlmLoading"
                      class="btn-icon"
                      title="Re-analyze with VLM"
                    >
                      <Loader2 v-if="vlmLoading" :size="14" class="animate-spin" />
                      <RefreshCw v-else :size="14" />
                    </button>
                    <button
                      v-if="!editingDesc"
                      @click="editingDesc = true; descEditText = currentImageDesc"
                      class="btn-icon"
                      title="Edit description"
                    >
                      <Pencil :size="14" />
                    </button>
                    <button
                      v-else
                      @click="saveDesc"
                      :disabled="descSaving"
                      class="btn-icon text-green-600"
                      title="Save"
                    >
                      <Save v-if="!descSaving" :size="14" />
                      <Loader2 v-else :size="14" class="animate-spin" />
                    </button>
                  </div>
                </div>
                <div v-if="editingDesc" class="desc-edit-area">
                  <textarea v-model="descEditText" class="desc-textarea" placeholder="Enter description..." />
                  <div class="flex gap-2 mt-1">
                    <button @click="saveDesc" :disabled="descSaving" class="btn-secondary text-xs">Save</button>
                    <button @click="editingDesc = false" class="btn-secondary text-xs">Cancel</button>
                  </div>
                </div>
                <p v-else-if="currentImageDesc" class="description-text">{{ currentImageDesc }}</p>
                <div v-else class="desc-empty-state">
                  <p class="text-xs muted-text">No description yet.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── Layout ── */
.doc-preview {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.doc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.header-actions-left,
.header-actions-right {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.header-actions-left {
  width: 84px;
}

.header-actions-right {
  width: 56px;
  justify-content: flex-end;
}

.header-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  gap: 6px;
}

.doc-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin: 0;
}

/* ── Buttons ── */
.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 150ms ease;
  flex-shrink: 0;
}

.icon-btn:hover {
  background: var(--accent-muted);
  color: var(--text-primary);
}

.icon-btn.active {
  background: var(--accent-muted);
  color: var(--accent-color);
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* ── States ── */
.center-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  text-align: center;
  gap: 12px;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.spinner-sm {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.muted-text {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}

.text-primary { color: var(--accent-color); }
.text-amber-500 { color: #f59e0b; }
.text-green-600 { color: #16a34a; }
.text-red-500 { color: #ef4444; }
.text-red-600 { color: #dc2626; }

/* ── Error banner ── */
.error-banner {
  padding: 8px 12px;
  margin: 0 16px;
  background: color-mix(in srgb, var(--bg-secondary) 90%, var(--accent-color) 10%);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-primary);
}

.edit-hint {
  font-size: 11px;
  color: var(--text-secondary);
  margin: 4px 16px 0;
}

/* ── Edit textarea ── */
.doc-edit-textarea {
  flex: 1;
  margin: 8px 16px;
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-color);
  font-family: monospace;
  font-size: 13px;
  resize: vertical;
  outline: none;
  color: var(--text-primary);
}

.doc-edit-textarea:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 2px var(--accent-muted);
}

/* ── Scroll area ── */
.doc-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-color);
  margin: 0 16px 8px;
}

.prose-container {
  padding: 24px 32px;
  max-width: 800px;
}

/* Optimize: skip paint/layout for off-screen rendered sections */
.prose-container > [data-section-idx] {
  content-visibility: auto;
}

/* ── Search Dialog ── */
.search-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  background: rgba(0, 0, 0, 0.3);
}

.search-dialog {
  width: 100%;
  max-width: 560px;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

.search-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.search-input {
  flex: 1;
  font-size: 14px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
}

.search-loading {
  display: flex;
  justify-content: center;
  padding: 32px;
}

.search-error {
  padding: 8px 16px;
  font-size: 14px;
  color: #ef4444;
}

.search-results {
  max-height: 60vh;
  overflow-y: auto;
}

.no-results {
  padding: 24px;
  text-align: center;
  font-size: 14px;
  color: var(--text-secondary);
}

.search-result-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 12px 16px;
  border: none;
  border-bottom: 1px solid var(--border-color);
  background: transparent;
  cursor: pointer;
  color: var(--text-primary);
  transition: background 150ms;
}

.search-result-item:hover {
  background: var(--accent-muted);
}

.search-result-item:last-child {
  border-bottom: none;
}

.search-result-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.search-result-preview {
  font-size: 12px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--text-secondary);
}

/* ── TOC Panel ── */
.toc-panel {
  position: fixed;
  z-index: 30;
  top: 68px;
  right: 12px;
  width: 240px;
  max-height: calc(100vh - 84px);
  display: flex;
  flex-direction: column;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.toc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--surface-raised);
  flex-shrink: 0;
}

.toc-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
}

.toc-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.toc-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.toc-headings {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.toc-heading-btn {
  display: block;
  width: 100%;
  text-align: left;
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 100ms;
}

.toc-heading-btn:hover {
  background: var(--accent-muted);
  color: var(--text-primary);
}

.toc-heading-btn.active {
  background: var(--accent-muted);
  color: var(--accent-color);
  font-weight: 500;
}

.toc-page-strip {
  width: 36px;
  flex-shrink: 0;
  overflow-y: auto;
  border-left: 1px solid var(--border-color);
  padding: 2px;
}

.toc-page-btn {
  display: block;
  width: 100%;
  text-align: center;
  padding: 2px 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 100ms;
}

.toc-page-btn:hover {
  background: var(--accent-muted);
  color: var(--text-primary);
}

.toc-footer {
  border-top: 1px solid var(--border-color);
  padding: 8px;
  flex-shrink: 0;
}

.page-input {
  flex: 1;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-color);
  text-align: center;
  outline: none;
  color: var(--text-primary);
}

.page-input:focus {
  border-color: var(--accent-color);
}

.page-input:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.page-jump-error {
  font-size: 10px;
  color: #ef4444;
  margin-top: 4px;
}

/* ── Images Panel ── */
.images-panel {
  position: fixed;
  z-index: 30;
  top: 68px;
  right: 12px;
  width: 240px;
  max-height: calc(100vh - 84px);
  display: flex;
  flex-direction: column;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.images-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--surface-raised);
  flex-shrink: 0;
}

.images-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
}

.images-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.images-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.images-body.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

.images-body.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.image-thumb-grid {
  aspect-ratio: 1;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: var(--surface-raised);
  cursor: pointer;
  padding: 0;
  transition: box-shadow 150ms;
}

.image-thumb-grid:hover {
  box-shadow: 0 0 0 2px var(--accent-color);
}

.image-thumb-list {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background 150ms;
}

.image-thumb-list:hover {
  background: var(--accent-muted);
}

.image-thumb-list-preview {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: var(--surface-raised);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.image-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 10px;
  color: var(--text-secondary);
}

/* ── Dialogs ── */
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.dialog-box {
  background: var(--bg-color);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
  width: 320px;
  max-width: 90vw;
  padding: 20px;
}

.dialog-box.fill-dialog {
  width: 384px;
}

.dialog-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 16px;
  color: var(--text-primary);
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dialog-footer {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

.btn-primary {
  flex: 1;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: var(--accent-color);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-secondary {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-primary);
}

.btn-secondary:hover {
  background: var(--accent-muted);
}

.toggle-btn {
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background: var(--surface-raised);
  color: var(--text-secondary);
  cursor: pointer;
}

.toggle-btn.active {
  background: var(--accent-color);
  color: #fff;
}

.page-offset-input {
  width: 64px;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-color);
  text-align: center;
  outline: none;
  color: var(--text-primary);
}

/* ── Progress ── */
.progress-bar {
  width: 100%;
  height: 8px;
  background: var(--surface-raised);
  border-radius: 999px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent-color);
  border-radius: 999px;
  transition: width 300ms ease;
}

.failed-details {
  max-height: 160px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.failed-item {
  padding: 8px;
  border-bottom: 1px solid var(--border-color);
}

.failed-item:last-child {
  border-bottom: none;
}

/* ── Image Dialog ── */
.image-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.85);
}

.image-dialog {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.image-dialog-close {
  position: absolute;
  top: -40px;
  right: 0;
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  padding: 4px;
}

.image-dialog-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.1);
  border: none;
  color: #fff;
  font-size: 32px;
  width: 48px;
  height: 64px;
  cursor: pointer;
  border-radius: 8px;
  transition: background 150ms;
}

.image-dialog-nav:hover {
  background: rgba(255, 255, 255, 0.2);
}

.image-dialog-nav.left { left: -60px; }
.image-dialog-nav.right { right: -60px; }

.image-dialog-body {
  display: flex;
  gap: 16px;
  max-width: 90vw;
  max-height: 85vh;
}

.image-dialog-image-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-width: 0;
}

.image-dialog-img {
  max-width: 60vw;
  max-height: 75vh;
  object-fit: contain;
  border-radius: 8px;
}

.image-dialog-loading {
  padding: 48px;
}

.image-dialog-meta-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  margin-top: 12px;
  color: #fff;
}

.image-dialog-name {
  font-size: 13px;
  color: #fff;
  margin-top: 12px;
}

/* ── Image Dialog Info Panel ── */
.image-dialog-info-panel {
  width: 300px;
  flex-shrink: 0;
  background: var(--bg-color, #fff);
  border-radius: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  max-height: 85vh;
  min-height: 0;
}

.image-dialog-panel-title {
  font-weight: 600;
  font-size: 13px;
  padding: 16px 16px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-desc-section {
  padding: 12px 16px 16px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.image-desc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.btn-icon {
  padding: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 4px;
  color: var(--text-secondary, #666);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  background: var(--accent-muted, #f0f0f0);
}

.btn-icon:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.text-muted-foreground {
  color: var(--text-secondary, #666);
}

.description-text {
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
}

.desc-edit-area {
  margin-top: 4px;
}

.desc-textarea {
  width: 100%;
  min-height: 100px;
  padding: 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-size: 12px;
  background: var(--bg-color, #fff);
  color: var(--text-primary, #222);
  resize: vertical;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
}

.desc-textarea:focus {
  border-color: var(--accent-color, #3b82f6);
  box-shadow: 0 0 0 1px var(--accent-color, #3b82f6);
}

.desc-empty-state {
  padding: 16px 0;
  text-align: center;
}

/* Override animation class for lucide spinner */
:global(.animate-spin) {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Focus mode ── */
:global(.skb-focus-mode) .doc-preview {
  max-width: 100%;
}
</style>