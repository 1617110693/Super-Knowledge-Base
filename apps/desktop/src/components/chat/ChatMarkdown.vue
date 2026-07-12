<template>
  <div class="chat-markdown" :class="'md-theme-' + injectedTheme" @click="onContentClick">
    <div class="prose prose-sm max-w-none dark:prose-invert" v-html="renderedHtml" />

    <!-- Image preview dialog -->
    <Teleport to="body">
      <div v-if="previewVisible" class="img-preview-overlay" @click="previewVisible = false">
        <div class="img-preview-container" @click.stop>
          <img :src="previewUrl" class="img-preview-full" />
          <button class="img-preview-close" @click="previewVisible = false">✕</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, onMounted, watch } from "vue";
import MarkdownIt from "markdown-it";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { SearchResult, WebSearchSource } from "@/types";
import { latexNormalize } from "@/utils/latexNormalize";
import { imageVersion, getImageUrl, ensureImagesLoaded } from "@/utils/resolveImages";

const props = withDefaults(
  defineProps<{
    content: string;
    sources?: SearchResult[];
    webSources?: WebSearchSource[];
    isStreaming?: boolean;
    theme?: string;
  }>(),
  { sources: () => [], webSources: () => [], isStreaming: false, theme: "academic" }
);

const injectedTheme = inject("markdownTheme", "academic");

const emit = defineEmits<{
  sourceClick: [source: SearchResult];
  webSourceClick: [source: WebSearchSource];
}>();

// Trigger image loading
function getCandidates() {
  return props.sources
    .filter((s): s is SearchResult & { kb_id: string; doc_id: string } => !!s.kb_id && !!s.doc_id)
    .map((s) => ({ kb_id: s.kb_id, doc_id: s.doc_id }));
}
onMounted(() => ensureImagesLoaded(props.content, getCandidates()));
watch(() => props.content, () => ensureImagesLoaded(props.content, getCandidates()));
watch(() => props.sources, () => ensureImagesLoaded(props.content, getCandidates()), { deep: true });

const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
});

// Custom math rendering - inline_math before emphasis to prevent _ conflicts
md.inline.ruler.before("emphasis", "inline_math", (state, silent) => {
  const pos = state.pos;
  if (state.src[pos] !== "$") return false;
  if (state.src[pos + 1] === "$") return false; // skip $$
  const end = state.src.indexOf("$", pos + 1);
  if (end === -1) return false;
  if (!silent) {
    const token = state.push("inline_math", "math", 0);
    token.content = state.src.slice(pos + 1, end);
    token.markup = "$";
  }
  state.pos = end + 1;
  return true;
});

// Display math - before paragraph to capture $$ blocks
md.block.ruler.before("paragraph", "display_math", (state, startLine, endLine, silent) => {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  if (state.src.slice(startPos, startPos + 2) !== "$$") return false;
  const end = state.src.indexOf("$$", startPos + 2);
  if (end === -1) return false;
  const content = state.src.slice(startPos + 2, end);
  if (!silent) {
    const token = state.push("display_math", "math", 0);
    token.content = content.trim();
    token.block = true;
  }
  const newLine = startLine + state.src.slice(state.bMarks[startLine], end).split("\n").length - 1;
  state.line = newLine + 1;
  return true;
});

// Render math tokens with throwOnError:false, strict:false
md.renderer.rules["inline_math"] = function (tokens, idx) {
  let content = tokens[idx].content.replace(/([_^])\s+(?=\{)/g, '$1');
  content = content.replace(/\\left\s*\{/g, '\\left\\{').replace(/\\right\s*\}/g, '\\right\\}');
  try {
    return katex.renderToString(content, { throwOnError: false, strict: false });
  } catch {
    return `$${tokens[idx].content}$`;
  }
};
md.renderer.rules["display_math"] = function (tokens, idx) {
  let content = tokens[idx].content.replace(/([_^])\s+(?=\{)/g, '$1');
  content = content.replace(/\\left\s*\{/g, '\\left\\{').replace(/\\right\s*\}/g, '\\right\\}');
  try {
    return katex.renderToString(content, { displayMode: true, throwOnError: false, strict: false });
  } catch {
    return `$$\n${tokens[idx].content}\n$$`;
  }
};

// Embed source badges [N] -> <sup class="skb-badge">
// Embed web source badges [W1], [W2] -> <sup class="web-badge">
function embedBadges(content: string): string {
  let result = content;
  // KB chunk citations: [N] or [N-M]
  if (props.sources?.length) {
    result = result.replace(/\[(\d+)(?:[-–](\d+))?\]/g, (m, n1, n2) => {
      const start = parseInt(n1) - 1;
      const end = n2 ? parseInt(n2) - 1 : start;
      if (start < 0 || end >= props.sources.length || start > end) return m;
      return `<sup data-source="${start}" class="skb-badge">${n1}</sup>`;
    });
  }
  // Web search citations: [W1], [W2], etc.
  if (props.webSources?.length) {
    result = result.replace(/\[W(\d+)\]/gi, (m, n1) => {
      const idx = parseInt(n1) - 1;
      if (idx < 0 || idx >= props.webSources.length) return m;
      return `<sup data-web-source="${idx}" class="web-badge">W${n1}</sup>`;
    });
  }
  return result;
}

// Helper: render $...$ math inside HTML element content
function renderInlineMathInHtml(inner: string): string {
  if (inner.includes('class="katex"') || inner.includes('class="katex-display"')) return inner;
  return inner.replace(/\$([^$]+?)\$/g, (_m: string, math: string) => {
    let content = math.replace(/([_^])\s+(?=\{)/g, '$1');
    content = content.replace(/\\left\s*\{/g, '\\left\\{').replace(/\\right\s*\}/g, '\\right\\}');
    try { return katex.renderToString(content, { throwOnError: false, strict: false }); }
    catch { return `$${math}$`; }
  });
}

const renderedHtml = computed(() => {
  // Access imageVersion reactively
  void imageVersion.value;
  const prepared = embedBadges(props.content);
  // Normalize LaTeX delimiters, wrap bare environments, fix \tag, etc.
  const processedContent = latexNormalize(prepared);
  let html = md.render(processedContent);
  // Post-process: render $...$ inside HTML tables (td/th)
  html = html.replace(/(<td[^>]*>)([\s\S]*?)(<\/td>)/gi, (_m: string, open: string, inner: string, close: string) => {
    return open + renderInlineMathInHtml(inner) + close;
  });
  html = html.replace(/(<th[^>]*>)([\s\S]*?)(<\/th>)/gi, (_m: string, open: string, inner: string, close: string) => {
    return open + renderInlineMathInHtml(inner) + close;
  });
  // Replace image src with resolved object URLs — thumbnail + click-to-expand
  let imgIdx = 0;
  html = html.replace(
    /<img\s+([^>]*?)src="([^"]+)"([^>]*?)\/?>/gi,
    (_m: string, before: string, src: string, after: string) => {
      // Only replace local doc images (have hash filenames)
      const fn = src.replace(/\\/g, "/").split("/").pop()!;
      const url = getImageUrl(fn);
      if (!url) return _m;
      const idx = imgIdx++;
      return `<span class="chat-image-wrap" data-img-idx="${idx}">`
        + `<img ${before}src="${url}"${after} class="chat-image-thumb" loading="lazy" />`
        + `</span>`;
    }
  );
  return html;
});

// ── Image preview dialog ──
const previewUrl = ref("");
const previewVisible = ref(false);

function onContentClick(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest(".chat-image-thumb") as HTMLElement | null;
  if (el) {
    previewUrl.value = (el as HTMLImageElement).src;
    previewVisible.value = true;
    return;
  }
  // Open external links in default browser
  const link = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
  if (link && link.href && !link.href.startsWith("http://localhost") && !link.href.startsWith(window.location.origin)) {
    e.preventDefault();
    e.stopPropagation();
    import("@tauri-apps/plugin-shell").then(({ open }) => open(link.href).catch(() => window.open(link.href, "_blank")));
    return;
  }
  onBadgeClick(e);
}

function onBadgeClick(e: MouseEvent) {
  // Web source badge click
  const webEl = (e.target as HTMLElement).closest("[data-web-source]") as HTMLElement | null;
  if (webEl && props.webSources) {
    const idx = parseInt(webEl.getAttribute("data-web-source") || "-1", 10);
    if (idx >= 0 && idx < props.webSources.length) {
      emit("webSourceClick", props.webSources[idx]);
      return;
    }
  }
  // KB source badge click
  const el = (e.target as HTMLElement).closest("[data-source], [data-source-start]") as HTMLElement | null;
  if (!el || !props.sources) return;
  const start = parseInt(el.getAttribute("data-source-start") || el.getAttribute("data-source") || "-1", 10);
  const end = parseInt(el.getAttribute("data-source-end") || String(start), 10);
  if (start >= 0 && end < props.sources.length) {
    emit("sourceClick", props.sources[start]);
  }
}
</script>

<style scoped>
.chat-markdown { line-height: 1.7; word-wrap: break-word; }
.chat-markdown :deep(pre) { background: var(--surface-raised); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px 16px; overflow-x: auto; }
.chat-markdown :deep(code) { font-family: "SF Mono", "Fira Code", "Consolas", monospace; font-size: 0.875em; color: var(--text-primary); }
.chat-markdown :deep(pre code) { background: none; padding: 0; }
.chat-markdown :deep(img) { max-width: 100%; border-radius: 6px; }
.chat-markdown :deep(.chat-image-thumb) { max-width: 220px; max-height: 160px; border-radius: 8px; border: 1px solid var(--border-color); margin: 8px 0; cursor: pointer; object-fit: cover; transition: opacity .15s; }
.chat-markdown :deep(.chat-image-thumb:hover) { opacity: .8; }
.chat-markdown :deep(.chat-image-wrap) { display: inline-block; }
.chat-markdown :deep(a) { color: var(--accent-color); text-decoration: none; }
.chat-markdown :deep(a:hover) { text-decoration: underline; }
.chat-markdown :deep(table) { width: 100%; border-collapse: collapse; }
.chat-markdown :deep(th), .chat-markdown :deep(td) { padding: 6px 10px; border: 1px solid var(--border-color); text-align: left; }
.chat-markdown :deep(th) { background: var(--surface-raised); font-weight: 600; }
.chat-markdown :deep(blockquote) { border-left: 3px solid var(--accent-color); margin: 0.5em 0; padding: 4px 12px; color: var(--text-secondary); background: var(--accent-muted); border-radius: 0 4px 4px 0; }
.chat-markdown :deep(ul), .chat-markdown :deep(ol) { padding-left: 1.5em; }
.chat-markdown :deep(h1), .chat-markdown :deep(h2), .chat-markdown :deep(h3), .chat-markdown :deep(h4) { color: var(--text-primary); font-weight: 600; margin: 1em 0 0.5em; }
</style>

<style>
@import "@/styles/academic.css";
@import "@/styles/github.css";

/* ── Image preview dialog (global, teleported to body) ── */
.img-preview-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,.7);
  display: flex; align-items: center; justify-content: center;
  cursor: default;
}
.img-preview-container {
  position: relative; max-width: 90vw; max-height: 90vh;
}
.img-preview-full {
  max-width: 100%; max-height: 90vh; object-fit: contain;
  border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,.4);
}
.img-preview-close {
  position: absolute; top: -36px; right: 0;
  background: none; border: none; color: #fff;
  font-size: 24px; cursor: pointer; padding: 4px 8px;
}
</style>