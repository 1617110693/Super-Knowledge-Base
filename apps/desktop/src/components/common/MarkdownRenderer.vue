<script setup lang="ts">
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import katex from "katex";
import "katex/dist/katex.min.css";

const props = defineProps<{
  content: string;
  sources?: any[];
}>();

const emit = defineEmits<{
  sourceClick: [source: any];
}>();

const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
});

// Inline math: $...$ (runs before emphasis so _ inside math is not treated as italic)
md.inline.ruler.before("emphasis", "inline_math", (state, silent) => {
  const pos = state.pos;
  if (state.src[pos] !== "$") return false;
  const end = state.src.indexOf("$", pos + 1);
  if (end === -1) return false;
  if (state.src[pos + 1] === "$") return false; // skip $$
  if (!silent) {
    const token = state.push("inline_math", "math", 0);
    token.content = state.src.slice(pos + 1, end);
    token.markup = "$";
  }
  state.pos = end + 1;
  return true;
});

// Display math: $$...$$ (before paragraph to capture $$ blocks)
md.block.ruler.before("paragraph", "display_math", (state, startLine, endLine, silent) => {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  if (state.src.slice(startPos, startPos + 2) !== "$$") return false;
  const end = state.src.indexOf("$$", startPos + 2);
  if (end === -1) return false;
  const content = state.src.slice(startPos + 2, end);
  if (!silent) {
    const token = state.push("display_math", "math", 0);
    token.content = content.trim();
    token.markup = "$$";
    token.block = true;
  }
  const newLine = startLine + state.src.slice(state.bMarks[startLine], end).split("\n").length - 1;
  state.line = newLine + 1;
  return true;
});

// Render math tokens
md.renderer.rules["inline_math"] = function (tokens, idx) {
  let content = tokens[idx].content.replace(/([_^])\s+(?=\{)/g, '$1');
  content = content.replace(/\\left\s*\{/g, '\\left\\{').replace(/\\right\s*\}/g, '\\right\\}');
  try { return katex.renderToString(content, { throwOnError: false, strict: false }); }
  catch { return `$${tokens[idx].content}$`; }
};
md.renderer.rules["display_math"] = function (tokens, idx) {
  let content = tokens[idx].content.replace(/([_^])\s+(?=\{)/g, '$1');
  content = content.replace(/\\left\s*\{/g, '\\left\\{').replace(/\\right\s*\}/g, '\\right\\}');
  try { return katex.renderToString(content, { displayMode: true, throwOnError: false, strict: false }); }
  catch { return `$$\n${tokens[idx].content}\n$$`; }
};

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
  // Pre-process \tag in inline math: convert $...\tag{N}...$ to display math
  let processedContent = props.content;
  processedContent = processedContent.replace(/\$([^$]+?)\\tag\{([^}]+)\}([^$]*?)\$/g, (_, before, tag, after) => {
    return `$$\n${before}${after}\n\\tag{${tag}}\n$$`;
  });
  // Normalize $$$...$$$ to $$...$$
  processedContent = processedContent.replace(/\$\$\$(.+?)\$\$\$/gs, '$$\n$1\n$$');
  // Catch: $ on its own line with \tag{N} before closing $ (MinerU multi-line format)
  processedContent = processedContent.replace(/^\$\n([\s\S]*?)\\tag\{([^}]+)\}\n\s*\$$/gm, (_, body, tag) => {
    return `$$\n${body.trim()}\n\\tag{${tag}}\n$$`;
  });

  let html = md.render(processedContent);

  // Post-process: render $...$ inside HTML elements (e.g. <td> in tables)
  // that markdown-it skipped because html:true treats HTML content as literal.
  // Only replace $...$ that are NOT already inside katex spans.
  html = html.replace(/(<td[^>]*>)([\s\S]*?)(<\/td>)/gi, (_m: string, open: string, inner: string, close: string) => {
    return open + renderInlineMathInHtml(inner) + close;
  });
  html = html.replace(/(<th[^>]*>)([\s\S]*?)(<\/th>)/gi, (_m: string, open: string, inner: string, close: string) => {
    return open + renderInlineMathInHtml(inner) + close;
  });
  html = html.replace(/(<figcaption[^>]*>)([\s\S]*?)(<\/figcaption>)/gi, (_m: string, open: string, inner: string, close: string) => {
    return open + renderInlineMathInHtml(inner) + close;
  });

  // Replace [N] or [N-M] with clickable source badges
  if (props.sources?.length) {
    html = html.replace(
      /\[(\d+)(?:[-–](\d+))?\]/g,
      (match: string, n1: string, n2?: string) => {
        const start = parseInt(n1, 10) - 1;
        const end = n2 ? parseInt(n2, 10) - 1 : start;
        if (
          start < 0 ||
          end >= (props.sources?.length ?? 0) ||
          start > end
        ) {
          return match;
        }
        if (start === end) {
          return `<sup data-source="${start}" class="skb-badge">${n1}</sup>`;
        }
        return `<sup data-source-start="${start}" data-source-end="${end}" class="skb-badge">${n1}-${n2}</sup>`;
      }
    );
  }

  return html;
});

function onBadgeClick(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest(
    "[data-source], [data-source-start]"
  ) as HTMLElement | null;
  if (!el || !props.sources) return;

  const start = parseInt(
    el.getAttribute("data-source-start") ||
      el.getAttribute("data-source") ||
      "-1",
    10
  );
  const end = parseInt(el.getAttribute("data-source-end") || String(start), 10);

  if (start >= 0 && end < props.sources.length) {
    emit("sourceClick", props.sources.slice(start, end + 1));
  }
}
</script>

<template>
  <div
    class="markdown-renderer prose prose-sm max-w-none dark:prose-invert"
    @click="onBadgeClick"
    v-html="renderedHtml"
  />
</template>

<style scoped>
.markdown-renderer {
  line-height: 1.7;
  word-wrap: break-word;
}

.markdown-renderer :deep(p) {
  margin: 0.5em 0;
}

.markdown-renderer :deep(pre) {
  background: var(--surface-raised);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
}

.markdown-renderer :deep(code) {
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  font-size: 0.875em;
  color: var(--text-primary, inherit);
}

.markdown-renderer :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown-renderer :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}

.markdown-renderer :deep(a) {
  color: var(--accent-color);
  text-decoration: none;
}

.markdown-renderer :deep(a:hover) {
  text-decoration: underline;
}

.markdown-renderer :deep(table) {
  width: 100%;
  border-collapse: collapse;
}

.markdown-renderer :deep(th),
.markdown-renderer :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  text-align: left;
}

.markdown-renderer :deep(th) {
  background: var(--surface-raised);
  font-weight: 600;
}

.markdown-renderer :deep(blockquote) {
  border-left: 3px solid var(--accent-color);
  margin: 0.5em 0;
  padding: 4px 12px;
  color: var(--text-secondary);
  background: var(--accent-muted);
  border-radius: 0 4px 4px 0;
}

.markdown-renderer :deep(ul),
.markdown-renderer :deep(ol) {
  padding-left: 1.5em;
}

.markdown-renderer :deep(h1),
.markdown-renderer :deep(h2),
.markdown-renderer :deep(h3),
.markdown-renderer :deep(h4) {
  color: var(--text-primary);
  font-weight: 600;
  margin: 1em 0 0.5em;
}

.markdown-renderer :deep(h1) { font-size: 1.5em; }
.markdown-renderer :deep(h2) { font-size: 1.25em; }
.markdown-renderer :deep(h3) { font-size: 1.1em; }
</style>
