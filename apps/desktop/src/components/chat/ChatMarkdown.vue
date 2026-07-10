<template>
  <div v-memo="[content]" class="chat-markdown" :class="'md-theme-' + injectedTheme" @click="onBadgeClick">
    <div class="prose prose-sm max-w-none dark:prose-invert" v-html="renderedHtml" />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import MarkdownIt from "markdown-it";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { SearchResult } from "@/types";
import { getBaseUrl } from "@/services/pythonClient";

const props = withDefaults(
  defineProps<{
    content: string;
    sources?: SearchResult[];
    isStreaming?: boolean;
    theme?: string;
  }>(),
  { sources: () => [], isStreaming: false, theme: "academic" }
);

const injectedTheme = inject("markdownTheme", "academic");

const emit = defineEmits<{
  sourceClick: [source: SearchResult];
}>();

const baseUrl = ref("");

// Lazily resolve baseUrl for images
async function getApiBase(): Promise<string> {
  if (!baseUrl.value) {
    try { baseUrl.value = await getBaseUrl(); } catch { baseUrl.value = ""; }
  }
  return baseUrl.value;
}

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
function embedBadges(content: string): string {
  if (!props.sources?.length) return content;
  return content.replace(/\[(\d+)(?:[-–](\d+))?\]/g, (m, n1, n2) => {
    const start = parseInt(n1) - 1;
    const end = n2 ? parseInt(n2) - 1 : start;
    if (start < 0 || end >= props.sources.length || start > end) return m;
    return `<sup data-source="${start}" class="skb-badge">${n1}</sup>`;
  });
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
  const prepared = embedBadges(props.content);
  // Pre-process \tag in inline math: convert $...\tag{N}...$ to display math
  let processedContent = prepared.replace(/\$([^$]+?)\\tag\{([^}]+)\}([^$]*?)\$/g, (_, before, tag, after) => {
    return `$$\n${before}${after}\n\\tag{${tag}}\n$$`;
  });
  // Normalize $$$...$$$ to $$...$$
  processedContent = processedContent.replace(/\$\$\$(.+?)\$\$\$/gs, '$$\n$1\n$$');
  // Catch: $ on its own line with \tag{N} before closing $ (MinerU multi-line format)
  processedContent = processedContent.replace(/^\$\n([\s\S]*?)\\tag\{([^}]+)\}\n\s*\$$/gm, (_, body, tag) => {
    return `$$\n${body.trim()}\n\\tag{${tag}}\n$$`;
  });
  let html = md.render(processedContent);
  // Post-process: render $...$ inside HTML tables (td/th)
  html = html.replace(/(<td[^>]*>)([\s\S]*?)(<\/td>)/gi, (_m: string, open: string, inner: string, close: string) => {
    return open + renderInlineMathInHtml(inner) + close;
  });
  html = html.replace(/(<th[^>]*>)([\s\S]*?)(<\/th>)/gi, (_m: string, open: string, inner: string, close: string) => {
    return open + renderInlineMathInHtml(inner) + close;
  });
  // Convert markdown img tags to clickable thumbnails via backend API
  // LLM writes ![](images/xxx.jpg) → markdown-it renders <img src="images/xxx.jpg">
  // We replace the src with backend API URL
  if (baseUrl.value) {
    html = html.replace(
      /<img\s+([^>]*?)src="images\/([^"]+)"([^>]*?)\/?>/gi,
      (_m: string, before: string, filename: string, after: string) => {
        const imgUrl = `${baseUrl.value}/api/v1/images/serve/${filename}`;
        return `<a href="${imgUrl}" target="_blank" class="chat-image-link"><img${before}src="${imgUrl}"${after} class="chat-image" loading="lazy" style="max-width:300px;border-radius:8px;border:1px solid var(--border-color);margin:8px 0;cursor:pointer" /></a>`;
      }
    );
  }
  return html;
});

// Trigger baseUrl resolution once
getApiBase();

function onBadgeClick(e: MouseEvent) {
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
</style>