<template>
  <div v-memo="[content]" class="chat-markdown">
    <template v-for="(node, idx) in rendered" :key="idx">
      <component :is="node" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onBeforeUnmount } from "vue";
import MarkdownIt from "markdown-it";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { SearchResult } from "@/types";

const props = withDefaults(
  defineProps<{
    content: string;
    sources?: SearchResult[];
    isStreaming?: boolean;
  }>(),
  { sources: () => [], isStreaming: false }
);

defineEmits<{
  sourceClick: [source: SearchResult];
}>();

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
});

// Custom math rendering
md.inline.ruler.push("inline_math", (state, silent) => {
  const pos = state.pos;
  if (state.src[pos] !== "$") return false;
  const end = state.src.indexOf("$", pos + 1);
  if (end === -1) return false;
  if (state.src[pos + 1] === "$") return false;
  if (!silent) {
    const token = state.push("inline_math", "math", 0);
    token.content = state.src.slice(pos + 1, end);
    token.markup = "$";
  }
  state.pos = end + 1;
  return true;
});

md.block.ruler.push("display_math", (state, startLine, endLine, silent) => {
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
  const newLine = state.src.slice(0, end).split("\n").length - 1;
  state.line = newLine + 1;
  return true;
});

md.renderer.rules["inline_math"] = function (tokens, idx) {
  try { return katex.renderToString(tokens[idx].content, { throwOnError: false }); }
  catch { return `$${tokens[idx].content}$`; }
};
md.renderer.rules["display_math"] = function (tokens, idx) {
  try { return katex.renderToString(tokens[idx].content, { displayMode: true, throwOnError: false }); }
  catch { return `$$\n${tokens[idx].content}\n$$`; }
};

interface TokenRender {
  type: string;
  tag: string;
  content?: string;
  children?: TokenRender[];
  info?: string;
}

/**
 * Render a single token tree into a VNode using h().
 * Handles block-level tokens (headings, paragraphs, code, math) and
 * delegates inline rendering to the markdown-it inline renderer.
 */
function renderToken(token: TokenRender, children?: unknown[]): ReturnType<typeof h> {
  switch (token.type) {
    case "heading_open": {
      const level = parseInt(token.tag.slice(1), 10);
      return h(`h${Math.min(Math.max(level, 1), 6)}`, { class: "chat-heading" });
    }
    case "paragraph_open":
      return h("p", { class: "chat-paragraph" });
    case "bullet_list_open":
      return h("ul", { class: "chat-list" });
    case "ordered_list_open":
      return h("ol", { class: "chat-list" });
    case "list_item_open":
      return h("li", { class: "chat-list-item" });
    case "blockquote_open":
      return h("blockquote", { class: "chat-blockquote" });
    case "hr":
      return h("hr", { class: "chat-hr" });
    default:
      return h("div");
  }
}

function renderInline(mdInstance: MarkdownIt, src: string): ReturnType<typeof h>[] {
  const vnodes: ReturnType<typeof h>[] = [];
  const html = mdInstance.renderInline(src);
  // Use v-html via a span for inline rendered content
  const wrapper = document.createElement("span");
  wrapper.innerHTML = html;
  vnodes.push(h("span", { innerHTML: html }));
  return vnodes;
}

/**
 * Compute the full VNode tree from parsed tokens.
 * Tokens from markdown-it are structured as flat arrays with open/close pairs.
 * We walk them and build VNodes with children via h().
 */
const rendered = computed(() => {
  const tokens = md.parse(props.content, {});
  const vnodes: ReturnType<typeof h>[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];

    switch (tok.type) {
      // ── Headings ──
      case "heading_open": {
        const level = parseInt(tok.tag.slice(1), 10);
        const closeIdx = tokens.findIndex((t, idx) => idx > i && t.type === "heading_close");
        const inlineTokens = closeIdx > i ? tokens.slice(i + 1, closeIdx) : [];
        const content = inlineTokens.map((t) => t.content).join("");
        const renderedHtml = md.renderInline(content);
        vnodes.push(
          h(
            `h${Math.min(Math.max(level, 1), 6)}`,
            { class: "chat-heading" },
            [h("span", { innerHTML: renderedHtml })]
          )
        );
        i = closeIdx > i ? closeIdx + 1 : i + 1;
        continue;
      }

      // ── Paragraphs ──
      case "paragraph_open": {
        const closeIdx = tokens.findIndex((t, idx) => idx > i && t.type === "paragraph_close");
        const inlineTokens = closeIdx > i ? tokens.slice(i + 1, closeIdx) : [];
        const inlineHtml = md.renderInline(
          inlineTokens.map((t) => t.content).join("")
        );
        vnodes.push(h("p", { class: "chat-paragraph" }, [h("span", { innerHTML: inlineHtml })]));
        i = closeIdx > i ? closeIdx + 1 : i + 1;
        continue;
      }

      // ── Code blocks (fenced and regular) ──
      case "fence":
      case "code_block": {
        const codeContent = tok.content;
        const lang = (tok as any).info || "";
        const codeVNode = h("code", { class: lang ? `language-${lang}` : "" }, codeContent);
        vnodes.push(
          h("pre", { class: "chat-code-block" }, [codeVNode])
        );
        i++;
        continue;
      }

      // ── Math blocks ──
      case "inline_math": {
        try {
          const html = katex.renderToString(tok.content, {
            displayMode: true,
            throwOnError: false,
            trust: true,
          });
          vnodes.push(h("div", { class: "chat-math-block", innerHTML: html }));
        } catch {
          vnodes.push(
            h("pre", { class: "chat-code-block" }, [
              h("code", tok.content),
            ])
          );
        }
        i++;
        continue;
      }

      // ── Block-level open/close handled by paired walk ──
      case "bullet_list_open":
      case "ordered_list_open":
      case "blockquote_open":
      case "heading_close":
      case "paragraph_close":
      case "list_item_close":
      case "bullet_list_close":
      case "ordered_list_close":
      case "blockquote_close":
        i++;
        continue;

      default:
        i++;
        continue;
    }
  }

  return vnodes;
});
</script>

<style scoped>
.chat-markdown {
  @apply leading-relaxed;
}

.chat-heading {
  @apply font-semibold mt-4 mb-2 text-inherit;
}
.chat-heading:first-child {
  @apply mt-0;
}
.chat-heading:nth-child(1) { @apply text-lg; }
.chat-heading:nth-child(2) { @apply text-base; }
.chat-heading:nth-child(3) { @apply text-sm; }
.chat-heading:nth-child(4) { @apply text-sm; }
.chat-heading:nth-child(5) { @apply text-xs; }
.chat-heading:nth-child(6) { @apply text-xs; }

.chat-paragraph {
  @apply mb-2 last:mb-0;
}

.chat-list {
  @apply list-disc pl-5 mb-2;
}

.chat-list-item {
  @apply mb-1;
}

.chat-blockquote {
  @apply border-l-2 border-gray-300 dark:border-gray-600 pl-3 italic text-gray-600 dark:text-gray-400 my-2;
}

.chat-code-block {
  @apply bg-gray-100 dark:bg-gray-800 rounded-md p-3 my-2 overflow-x-auto text-sm;
}

.chat-code-block code {
  @apply font-mono text-sm;
}

.chat-math-block {
  @apply my-3 overflow-x-auto text-center;
}

.chat-hr {
  @apply my-3 border-gray-300 dark:border-gray-600;
}

:deep(a) {
  @apply text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300;
}

:deep(code) {
  @apply font-mono text-sm bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded;
}

:deep(pre code) {
  @apply bg-transparent p-0;
}

:deep(strong) {
  @apply font-semibold;
}

:deep(em) {
  @apply italic;
}

:deep(table) {
  @apply w-full border-collapse my-2 text-sm;
}

:deep(th) {
  @apply border border-gray-300 dark:border-gray-600 px-2 py-1 bg-gray-100 dark:bg-gray-800 font-medium;
}

:deep(td) {
  @apply border border-gray-300 dark:border-gray-600 px-2 py-1;
}

:deep(img) {
  @apply max-w-full h-auto rounded my-2;
}
</style>
