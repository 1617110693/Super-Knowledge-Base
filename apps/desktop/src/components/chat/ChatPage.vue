<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div class="flex items-center gap-3 px-6 py-3 border-b shrink-0 bg-card/50">
      <MessageSquare class="w-5 h-5 text-primary" />
      <h2 class="font-semibold text-sm truncate flex-1">
        {{ conv?.title || conv?.messages?.[0]?.content?.slice(0, 30) || t("chat.new") }}
      </h2>

      <!-- Context window toggle -->
      <label
        class="flex items-center gap-1 text-[11px] text-muted-foreground"
        :title="t('chat.contextWindowHelp') || 'Include neighboring chunks in search results for more context'"
      >
        <span class="hidden sm:inline">{{ t("chat.contextWindow") || "Ctx" }}</span>
        <select
          :value="contextWindow"
          class="px-1.5 py-0.5 border rounded bg-background text-[11px]"
          @change="handleContextWindowChange"
        >
          <option :value="0">±0</option>
          <option :value="1">±1</option>
          <option :value="2">±2</option>
        </select>
      </label>

      <!-- Web search toggle -->
      <button
        class="group flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all duration-200 select-none"
        :class="webSearchEnabled
          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800'
          : 'bg-muted/60 text-muted-foreground border border-transparent hover:bg-muted hover:text-foreground/70'"
        :title="t('chat.webSearch')"
        @click="toggleWebSearch"
      >
        <Globe class="w-4 h-4 transition-transform" :class="{ 'opacity-50': !webSearchEnabled }" />
        <span>{{ webSearchEnabled ? (t('chat.webSearchOn') || 'On') : (t('chat.webSearchOff') || 'Off') }}</span>
      </button>

      <!-- Multi-select KB dropdown -->
      <KBSelector
        :kbs="kbStore.knowledgeBases"
        :selected-kb-ids="selectedKbIds"
        :no-kb-label="t('chat.noKb') || 'No KB'"
        :kb-count-label="(count: number) => (t('chat.kbCount') || '{} KBs').replace('{}', String(count))"
        @toggle="toggleKb"
        @clear-all="clearAllKbs"
      />

      <button
        class="p-1.5 hover:bg-muted rounded-md text-muted-foreground"
        :title="t('chat.new') || 'New'"
        @click="handleNew"
      >
        <Plus class="w-4 h-4" />
      </button>
      <button
        class="p-1.5 hover:bg-muted rounded-md"
        :class="autoScroll ? 'text-primary' : 'text-muted-foreground'"
        :title="t('chat.autoScroll') || 'Auto-scroll'"
        @click="autoScroll = !autoScroll"
      >
        <ArrowDownToLine class="w-4 h-4" />
      </button>
      <template v-if="messages.length > 0">
        <button
          class="p-1.5 hover:bg-muted rounded-md text-muted-foreground"
          :title="t('chat.regenerate') || 'Regenerate'"
          :disabled="streaming"
          @click="handleRegenerate"
        >
          <RefreshCw class="w-4 h-4" />
        </button>
        <button
          class="p-1.5 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500"
          :title="t('chat.clear') || 'Delete'"
          @click="handleDelete"
        >
          <Trash2 class="w-4 h-4" />
        </button>
      </template>
    </div>

    <!-- Selected KB tags -->
    <div v-if="selectedKbIds.length > 1" class="flex flex-wrap gap-1 px-6 py-1.5 border-b shrink-0 bg-muted/20">
      <span
        v-for="id in selectedKbIds"
        :key="id"
        class="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary rounded-full pl-2 pr-1 py-0.5"
      >
        {{ kbNameById(id) }}
        <X class="w-3 h-3 cursor-pointer hover:text-red-500" @click="removeKb(id)" />
      </span>
    </div>

    <!-- Messages -->
    <div ref="scrollRef" class="flex-1 overflow-y-auto px-6 py-4" style="overflow-anchor: auto">
      <!-- Empty state -->
      <div v-if="messages.length === 0 && !toolStatus" class="flex items-center justify-center h-full">
        <div class="text-center py-16">
          <MessageSquare class="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p class="text-sm text-muted-foreground">{{ t("chat.emptyHint") || "Type a message to start" }}</p>
          <p v-if="selectedKbIds.length === 0" class="text-xs text-muted-foreground mt-1">
            {{ t("chat.selectKbHint") || "Select a knowledge base to enable RAG" }}
          </p>
        </div>
      </div>
      <!-- Messages list -->
      <ChatMessageList
        v-else
        :messages="messages"
        :streaming="streaming"
        :tool-results="toolResults"
        :active-tool-id="activeToolId"
        :copied-msg-idx="copiedMsgIdx"
        :auto-scroll="autoScroll"
        :scroll-ref="scrollRef"
        @source-click="setPreviewChunk"
        @copy="handleCopy"
        @toggle-auto-scroll="autoScroll = !autoScroll"
      />
    </div>

    <!-- Sources + Error -->
    <div class="px-6 shrink-0">
      <SourcesPanel
        :sources="lastAssistantSources"
        :sources-label="t('chat.sources') || 'Sources'"
        @source-click="setPreviewChunk"
      />
      <div v-if="error" class="p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 mt-2">
        {{ error }}
      </div>
    </div>

    <!-- Input -->
    <ChatInput
      :streaming="streaming"
      :placeholder="t('chat.placeholder') || 'Type a message...'"
      @send="handleSend"
      @stop="handleStop"
    />

    <!-- Scroll to bottom FAB -->
    <Transition name="fade">
      <button
        v-if="showScrollBtn"
        class="absolute bottom-24 right-8 z-30 p-2 bg-card border rounded-full shadow-md hover:shadow-lg transition-all"
        @click="scrollToBottomAndEnable"
      >
        <ArrowDown class="w-4 h-4 text-muted-foreground" />
      </button>
    </Transition>

    <!-- Chunk preview dialog -->
    <ChunkDetailDialog
      v-if="previewChunk"
      :visible="true"
      :chunk="previewChunk"
      @update:visible="previewChunk = null"
      @prev="navigatePreviewChunk(-1)"
      @next="navigatePreviewChunk(1)"
      @openDocument="openDocFromChunk"
      @openInPdf="openPdfFromChunk"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  MessageSquare, Plus, ArrowDownToLine, ArrowDown,
  RefreshCw, Trash2, X, Globe,
} from "lucide-vue-next";
import type { ChatMessage, SearchResult, ToolCall } from "@/types";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useKBStore } from "@/stores/kbStore";
import { useTabStore } from "@/stores/tabStore";
import { CHAT_TOOLS, toolLabel } from "@/services/toolDefinitions";
import { executeToolCall } from "@/services/toolExecutor";
import { getChunkByIndex, getChunkRange } from "@/services/pythonClient";
import { listDocuments } from "@/services/tauriBridge";
import { loadMemoryGraph, formatMemoryForPrompt } from "@/services/memoryStore";
import { useI18n } from "@/i18n/index";
import KBSelector from "./KBSelector.vue";
import ChatMessageList from "./ChatMessageList.vue";
import ChatInput from "./ChatInput.vue";
import SourcesPanel from "./SourcesPanel.vue";
import ChunkDetailDialog from "@/components/common/ChunkDetailDialog.vue";
import { latexNormalize } from "@/utils/latexNormalize";

const { t } = useI18n();

// ── Normalize LaTeX math delimiters using shared utility ──
const normalizeMath = latexNormalize;

// ── Route & Stores ──
const route = useRoute();
const router = useRouter();
const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const kbStore = useKBStore();
const tabStore = useTabStore();

// ── Local state ──
const streaming = ref(false);
const error = ref("");
const toolStatus = ref("");
const toolResults = ref<Record<string, string>>({});
const activeToolId = ref<string | null>(null);
const manualExpand = ref<Set<string>>(new Set());
const copiedMsgIdx = ref<number | null>(null);
const showScrollBtn = ref(false);
const autoScroll = ref(true);
const abortCtrl = ref<AbortController | null>(null);
const scrollRef = ref<HTMLElement | null>(null);
const previewChunk = ref<SearchResult | null>(null);
const lastScrollSave = ref(0);

// ── Computed ──
const convId = computed(() => route.params.convId as string | undefined);

const conv = computed(() =>
  chatStore.conversations.find(
    (c) => c.id === (convId.value || chatStore.activeConversationId)
  )
);

const messages = computed<ChatMessage[]>(() => conv.value?.messages || []);

const selectedKbIds = computed<string[]>(
  () => conv.value?.chatSettings?.selectedKbIds ?? []
);

const contextWindow = computed<number>(
  () => conv.value?.chatSettings?.contextWindow ?? 1
);

const webSearchEnabled = computed<boolean>(
  () => conv.value?.chatSettings?.webSearchEnabled ?? false
);

// Collect all sources from the most recent assistant message
const lastAssistantSources = computed<SearchResult[]>(() => {
  const reversed = [...messages.value].reverse();
  const lastAsst = reversed.find((m) => m.role === "assistant");
  return lastAsst?.sources || [];
});

// ── KB helpers ──
function kbNameById(id: string): string {
  return kbStore.knowledgeBases.find((kb) => kb.id === id)?.name || id;
}

// ── Initialize conversation ──
onMounted(async () => {
  await chatStore.load();
  await kbStore.loadKBs();
  loadMemoryGraph().catch(() => {});

  const cid = route.params.convId as string | undefined;
  if (cid) {
    chatStore.setActiveConversation(cid);
  } else if (!chatStore.activeConversationId) {
    const id = chatStore.newConversation();
    router.replace(`/chat/${id}`);
  }
});

// ── Browser tab title ──
watch(
  () => [conv.value?.title, conv.value?.messages?.[0]?.content, convId.value],
  () => {
    const title = conv.value?.title || conv.value?.messages?.[0]?.content?.slice(0, 30) || "New Chat";
    document.title = `${title} — SKB`;
  },
  { immediate: true }
);

// ── Scroll helpers ──
function scrollToBottom(smooth = true) {
  const el = scrollRef.value;
  if (!el) return;
  const behavior = (smooth && !streaming.value) ? "smooth" : "instant";
  requestAnimationFrame(() => {
    el.scrollTo({ top: el.scrollHeight, behavior: behavior as ScrollBehavior });
  });
}

function scrollToBottomAndEnable() {
  autoScroll.value = true;
  scrollToBottom();
}

// Auto-scroll when messages change
watch(
  () => [messages.value, toolStatus.value, autoScroll.value] as const,
  () => {
    if (autoScroll.value) scrollToBottom();
  }
);

// Track scroll position and restore on mount
let scrollListener: (() => void) | null = null;

onMounted(() => {
  const el = scrollRef.value;
  if (!el) return;

  const onScroll = () => {
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    showScrollBtn.value = dist > 200;
    if (dist < 4) {
      autoScroll.value = true;
    } else if (dist > 20) {
      autoScroll.value = false;
    }
    // Save scroll position to tab store (throttled to 500ms)
    const now = Date.now();
    if (now - lastScrollSave.value > 500 && conv.value) {
      lastScrollSave.value = now;
      const tab = tabStore.tabs.find((t: any) => t.url === `/chat/${conv.value!.id}`);
      if (tab) {
        tabStore.updateTabCache(tab.id, { scrollPosition: el.scrollTop });
      }
    }
  };

  el.addEventListener("scroll", onScroll, { passive: true });
  scrollListener = () => el.removeEventListener("scroll", onScroll);

  // Restore scroll position on mount
  const tab = tabStore.tabs.find((t: any) => t.url === `/chat/${conv.value?.id}`);
  if (tab && tab.scrollPosition && tab.scrollPosition > 0) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollTop = tab.scrollPosition!;
      });
    });
  }
});

onUnmounted(() => {
  scrollListener?.();
});

// ── Chat settings handlers ──
function toggleKb(id: string) {
  if (!conv.value) return;
  const next = selectedKbIds.value.includes(id)
    ? selectedKbIds.value.filter((x) => x !== id)
    : [...selectedKbIds.value, id];
  chatStore.updateChatSettings(conv.value.id, { selectedKbIds: next });
}

function removeKb(id: string) {
  if (!conv.value) return;
  chatStore.updateChatSettings(conv.value.id, {
    selectedKbIds: selectedKbIds.value.filter((x) => x !== id),
  });
}

function clearAllKbs() {
  if (!conv.value) return;
  chatStore.updateChatSettings(conv.value.id, { selectedKbIds: [] });
}

function handleContextWindowChange(e: Event) {
  if (!conv.value) return;
  const val = Number((e.target as HTMLSelectElement).value);
  chatStore.updateChatSettings(conv.value.id, { contextWindow: val });
}

function toggleWebSearch() {
  if (!conv.value) return;
  chatStore.updateChatSettings(conv.value.id, {
    webSearchEnabled: !conv.value.chatSettings.webSearchEnabled,
  });
}

// ── Conversation actions ──
function handleNew() {
  const id = chatStore.newConversation();
  router.push(`/chat/${id}`);
}

function handleDelete() {
  if (!conv.value) return;
  const c = conv.value;
  chatStore.deleteConversation(c.id);
  const tab = tabStore.tabs.find((t: any) => t.url === `/chat/${c.id}`);
  if (tab) tabStore.closeTab(tab.id);
  const id = chatStore.newConversation();
  router.replace(`/chat/${id}`);
}

function handleStop() {
  abortCtrl.value?.abort();
  abortCtrl.value = null;
  streaming.value = false;
  toolStatus.value = "";
}

async function handleCopy(content: string, idx: number) {
  await navigator.clipboard.writeText(content);
  copiedMsgIdx.value = idx;
  setTimeout(() => {
    copiedMsgIdx.value = null;
  }, 2000);
}

async function handleRegenerate() {
  if (!conv.value || streaming.value) return;
  const msgs = [...conv.value.messages];
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return;
  const lastUserContent = msgs[lastUserIdx].content;
  // Remove last assistant message(s) and tool results from store
  const trimmed = msgs.slice(0, lastUserIdx);
  chatStore.conversations = chatStore.conversations.map((c) => {
    if (c.id !== conv.value!.id) return c;
    return { ...c, messages: trimmed, updatedAt: new Date().toISOString() };
  });
  handleSend(lastUserContent);
}

// ── System prompt builder ──
function buildInstr(): string {
  const mathInstr =
    "Wrap ALL math in $..$ or $$..$$. Single symbols too: $x$, $\\alpha$, $A$. Display equations: $$A^T A$$. No bare LaTeX.";
  const citeInstr =
    "IMPORTANT: Each search result has an 'index' field (1,2,3...) AND a 'chunk_index' field (document position). Use the INDEX number for citation: write [N] where N is the result index, NOT the chunk_index. Example: if result index=1 has chunk_index=8, cite it as [1], not [8].";
  const imageInstr =
    "IMPORTANT — YOU MUST INCLUDE IMAGES IN YOUR ANSWER: Before writing your final answer, ALWAYS search for images related to the topic. When search results include content_type='image' chunks, you MUST render them inline using: ![description](images/filename.jpg). Additionally, look at ALL search result content for image filenames (patterns like 'Image: hash.jpg', 'images/hash.jpg', or markdown image syntax). Extract these filenames and include the images. If you reference a diagram, chart, figure, or visual concept but no image chunk was returned, use search_knowledge_base with content_type='image' to specifically find related images. Images are key visual evidence — never skip them, they appear as clickable thumbnails that the user can preview.";
  const webSearchEnabledVal = conv.value?.chatSettings?.webSearchEnabled ?? false;
  const webInstr =
    `WEB SEARCH (ENABLED): You MUST call web_search before answering whenever the question involves (a) recent events, news, or dates after your training cutoff, (b) real-time or live information, (c) specific facts you are not confident about, or (d) anything beyond the selected knowledge bases. Do NOT answer from memory alone if web_search could give a fresher or more accurate answer. After web_search, use web_fetch to read a specific result page if you need full detail. Cite web results by URL or title so the user knows the source.`;
  const kbNames =
    selectedKbIds.value.length > 0
      ? selectedKbIds.value
          .map((id) => kbStore.knowledgeBases.find((kb) => kb.id === id)?.name || id)
          .join(", ")
      : "";
  const ragInstr = kbNames
    ? `You have access to knowledge bases: ${kbNames}.

HOW TO ANSWER QUESTIONS (RAG-first workflow):
1. Use search_knowledge_base to find the most relevant chunks across all KBs. This is your PRIMARY tool for answering questions — it returns precise, pre-chunked content.
2. If you need more context around a result, use get_chunk_by_index with neighboring chunk_index values, or search_knowledge_base with context_window > 0.
3. DO NOT use get_document or get_document_chunks to answer questions — documents can be hundreds of pages and will overflow context. These tools are for browsing/document management, not Q&A.
4. get_document_summary gives you a document's structure (headings, chunk count) without loading content — use it to understand what a document covers.`
    : "";
  let systemMsg = kbNames
    ? `${ragInstr}\n\n${citeInstr}\n\n${imageInstr}`
    : "You are a helpful assistant.";
  if (webSearchEnabledVal) systemMsg += `\n\n${webInstr}`;
  // Inject memory context
  const memoryPrompt = formatMemoryForPrompt(2000);
  if (memoryPrompt) systemMsg += `\n\n${memoryPrompt}`;
  systemMsg += `\n\n${mathInstr}`;
  return systemMsg;
}

// ── Handle send: full tool-calling loop ──
async function handleSend(text?: string) {
  if (streaming.value) return;

  const currentConv = chatStore.conversations.find(
    (c) => c.id === (convId.value || chatStore.activeConversationId)
  );
  if (!currentConv) return;

  const msg = text?.trim();
  if (!msg) return;

  const userMsg: ChatMessage = { role: "user", content: msg };
  chatStore.addMessage(currentConv.id, userMsg);
  error.value = "";
  autoScroll.value = true;
  streaming.value = true;
  // Mark this conv as streaming — store writes skip disk I/O until cleared
  chatStore.setStreamingConv(currentConv.id);

  // Add placeholder assistant message
  chatStore.addMessage(currentConv.id, { role: "assistant", content: "" });

  try {
    const apiBase = (settingsStore.settings.llm_api_base || "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKey = settingsStore.settings.llm_api_key || "";
    const model = settingsStore.settings.llm_model || "gpt-4o-mini";

    if (!apiKey) {
      chatStore.updateLastAssistant(currentConv.id, "Please configure an LLM API key in settings.");
      streaming.value = false;
      return;
    }

    const systemMsg = buildInstr();

    // Build conversation history including tool messages
    const rawHistory = ([...currentConv.messages, userMsg] as ChatMessage[])
      .filter((m) => m.content || m.tool_calls)
      .slice(-(settingsStore.settings.max_history_messages || 80));

    const llmMessages: Array<Record<string, unknown>> = [
      { role: "system", content: systemMsg },
      ...rawHistory.map((m) => {
        const out: Record<string, unknown> = { role: m.role };
        if (m.content) out.content = m.content;
        else out.content = null;
        if (m.tool_calls)
          out.tool_calls = m.tool_calls.map((tc: ToolCall) => ({
            id: tc.id,
            type: "function",
            function: tc.function,
          }));
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.name) out.name = m.name;
        return out;
      }),
    ];

    // ── Tool-calling loop ──
    let allSources: SearchResult[] = [];
    const kbList = kbStore.knowledgeBases; // snapshot at send time

    for (let round = 0; round < (settingsStore.settings.max_tool_rounds || 10); round++) {
      // Filter tools
      const noKb = selectedKbIds.value.length === 0;
      let activeTools = CHAT_TOOLS;
      if (!webSearchEnabled.value)
        activeTools = activeTools.filter(
          (t) => t.function.name !== "web_search" && t.function.name !== "web_fetch"
        );
      if (noKb)
        activeTools = activeTools.filter(
          (t) =>
            ![
              "search_knowledge_base",
              "get_document",
              "get_document_chunks",
              "list_documents",
              "get_chunk_by_index",
              "get_chunks_by_page",
              "list_knowledge_bases",
            ].includes(t.function.name)
        );

      const controller = new AbortController();
      abortCtrl.value = controller;

      const resp = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: llmMessages,
          tools: activeTools,
          tool_choice: "auto",
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(err);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();

      let fullContent = "";
      let fullReasoning = "";
      const toolCallsAcc = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let finishReason = "";

      // Throttled store updates during streaming (80ms)
      let lastFlush = 0;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushContent = () => {
        chatStore.updateLastAssistant(currentConv.id, fullContent, allSources, fullReasoning);
        lastFlush = Date.now();
        flushTimer = null;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const choice = json.choices?.[0];
            const delta = choice?.delta;
            finishReason = choice?.finish_reason || finishReason;

            if (delta?.reasoning_content) {
              fullReasoning += delta.reasoning_content;
            }
            if (delta?.content) {
              fullContent += delta.content;
            }
            // Throttle store updates for BOTH content and reasoning
            if (delta?.content || delta?.reasoning_content) {
              const now = Date.now();
              if (now - lastFlush >= 80 && !flushTimer) {
                flushContent();
              } else if (!flushTimer) {
                flushTimer = setTimeout(flushContent, 80 - (now - lastFlush));
              }
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsAcc.has(idx)) {
                  toolCallsAcc.set(idx, {
                    id: tc.id || "",
                    name: "",
                    arguments: "",
                  });
                }
                const entry = toolCallsAcc.get(idx)!;
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name += tc.function.name;
                if (tc.function?.arguments) entry.arguments += tc.function.arguments;
              }
            }
          } catch {
            /* ignore malformed JSON in stream */
          }
        }
      }

      // No tool calls — final answer
      if (finishReason === "stop" && toolCallsAcc.size === 0) {
        if (flushTimer) clearTimeout(flushTimer);
        fullContent = normalizeMath(fullContent);
        chatStore.updateLastAssistant(currentConv.id, fullContent, allSources, fullReasoning);
        break;
      }

      // Tool calls requested — execute them
      if (toolCallsAcc.size > 0) {
        const tcArray: ToolCall[] = Array.from(toolCallsAcc.values()).map((tc) => ({
          id: tc.id,
          function: { name: tc.name, arguments: tc.arguments },
        }));

        // Save assistant message with tool_calls
        chatStore.updateLastAssistantWithToolCalls(
          currentConv.id,
          fullContent,
          tcArray,
          allSources
        );

        // Append assistant message (with tool_calls) to the LLM message list
        llmMessages.push({
          role: "assistant",
          content: fullContent || null,
          tool_calls: tcArray.map((tc) => ({
            id: tc.id,
            type: "function",
            function: tc.function,
          })),
        });

        // Execute each tool call
        for (const tc of tcArray) {
          toolStatus.value = toolLabel(tc);
          activeToolId.value = tc.id;
          // Collapse all previously manual-expanded cards for new tool round
          manualExpand.value = new Set();
          try {
            const { result, newSources } = await executeToolCall(
              tc,
              kbList.map((kb) => ({
                id: kb.id,
                name: kb.name,
                document_count: kb.document_count,
                chunk_count: kb.chunk_count,
              })),
              {
                maxSearchResultChars: settingsStore.settings.max_search_result_chars || 2000,
                maxDocumentChars: settingsStore.settings.max_document_chars || 30000,
                maxChunkChars: settingsStore.settings.max_chunk_chars || 800,
              },
              selectedKbIds.value.length > 0 ? selectedKbIds.value : undefined,
              contextWindow.value,
              allSources.length
            );
            allSources = [...allSources, ...newSources];
            // Store tool result for UI display
            toolResults.value = { ...toolResults.value, [tc.id]: result.content };
            llmMessages.push({
              role: "tool",
              tool_call_id: result.tool_call_id,
              content: result.content,
              name: tc.function.name,
            });
            // Save tool result to conversation store for multi-turn history
            chatStore.addMessage(currentConv.id, {
              role: "tool",
              content: result.content,
              tool_call_id: result.tool_call_id,
              name: tc.function.name,
            });
          } catch (toolErr) {
            const errContent = JSON.stringify({ error: String(toolErr) });
            llmMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: errContent,
              name: tc.function.name,
            });
            chatStore.addMessage(currentConv.id, {
              role: "tool",
              content: errContent,
              tool_call_id: tc.id,
              name: tc.function.name,
            });
          }
        }
        toolStatus.value = "";

        // New placeholder for the next LLM response
        chatStore.addMessage(currentConv.id, { role: "assistant", content: "" });
        fullContent = "";
      } else {
        break; // finish_reason=stop with no content (edge case)
      }
    } // end tool-calling loop
  } catch (e: any) {
    if (e.name === "AbortError") {
      // User stopped — no error display needed
    } else {
      const errMsg = String(e);
      chatStore.updateLastAssistant(currentConv.id, `Error: ${errMsg}`);
      error.value = errMsg;
    }
  }
  streaming.value = false;
  toolStatus.value = "";
  // Stream done — persist the conversation once. Only clear the streaming
  // flag if it still points at us.
  if (chatStore.streamingConvId === currentConv.id) {
    chatStore.setStreamingConv(null);
  }
  chatStore.persistConversation(currentConv.id);
}

// ── Chunk preview ──
function setPreviewChunk(chunk: SearchResult) {
  previewChunk.value = chunk;
}

// ── Chunk preview navigation ──
function navigatePreviewChunk(delta: number) {
  const pc = previewChunk.value;
  if (!pc || !pc.kb_id || !pc.doc_id) return;
  if (pc.metadata?.chunk_index == null) return;
  const ci = pc.metadata.chunk_index as number;
  const kb = pc.kb_id;
  const did = pc.doc_id;
  getChunkByIndex({ kb_id: kb, doc_id: did, chunk_index: ci + delta })
    .then((res) => {
      if (!("error" in res)) {
        const c = res.chunk;
        previewChunk.value = {
          ...pc,
          content: c.content,
          chunk_id: c.chunk_id,
          page_start: c.page_start,
          page_end: c.page_end,
          metadata: {
            ...pc.metadata,
            chunk_index: c.chunk_index,
            page: c.page_number,
            page_start: c.page_start,
            page_end: c.page_end,
          },
        };
        return;
      }
      // Cross-part navigation for split documents
      listDocuments(kb)
        .then((docs) => {
          const curParent = (docs.find((d) => d.id === did) as any)?.parent_doc_id;
          const siblings = docs
            .filter((d) => d.id !== did)
            .filter(
              (d) =>
                (curParent && (d as any).parent_doc_id === curParent) ||
                (d as any).parent_doc_id === did
            )
            .sort((a, b) => a.name.localeCompare(b.name));
          if (!siblings.length) return;
          const curIdx = siblings.findIndex(
            (d) => d.name.localeCompare(pc.doc_name!) > 0
          );
          const target =
            delta > 0
              ? curIdx >= 0
                ? siblings[curIdx]
                : siblings[0]
              : curIdx > 0
                ? siblings[curIdx - 1]
                : siblings[siblings.length - 1];
          if (!target) return;
          if (delta > 0) {
            getChunkByIndex({
              kb_id: kb,
              doc_id: target.id,
              chunk_index: 0,
            })
              .then((r2) => {
                if ("error" in r2) return;
                const c2 = r2.chunk;
                previewChunk.value = {
                  ...pc,
                  content: c2.content,
                  chunk_id: c2.chunk_id,
                  doc_id: c2.doc_id,
                  doc_name: c2.doc_name,
                  page_start: c2.page_start,
                  page_end: c2.page_end,
                  metadata: {
                    ...pc.metadata,
                    chunk_index: c2.chunk_index,
                    page: c2.page_number,
                    page_start: c2.page_start,
                    page_end: c2.page_end,
                  },
                };
              })
              .catch(() => {});
          } else {
            getChunkRange({
              kb_id: kb,
              doc_id: target.id,
              start: 0,
              end: 100000,
            })
              .then((r2) => {
                const chunks = r2.chunks || [];
                if (!chunks.length) return;
                const last = chunks.reduce((a, b) =>
                  a.chunk_index > b.chunk_index ? a : b
                );
                previewChunk.value = {
                  ...pc,
                  content: last.content,
                  chunk_id: last.chunk_id,
                  doc_id: last.doc_id,
                  doc_name: last.doc_name,
                  page_start: last.page_start,
                  page_end: last.page_end,
                  metadata: {
                    ...pc.metadata,
                    chunk_index: last.chunk_index,
                    page: last.page_number,
                    page_start: last.page_start,
                    page_end: last.page_end,
                  },
                };
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    })
    .catch(() => {});
}

// ── Open document from chunk preview ──
function openDocFromChunk(docId: string) {
  if (previewChunk.value) {
    const kbId = previewChunk.value.kb_id;
    const ci = previewChunk.value.metadata?.chunk_index;
    const url = ci != null
      ? `/kb/${kbId}/documents/${docId}?ci=${ci}`
      : `/kb/${kbId}/documents/${docId}`;
    router.push(url);
    previewChunk.value = null;
  }
}

function openPdfFromChunk(docId: string) {
  if (previewChunk.value) {
    const kbId = previewChunk.value.kb_id;
    const ci = previewChunk.value.metadata?.chunk_index;
    const url = ci != null
      ? `/kb/${kbId}/documents/${docId}?view=pdf&ci=${ci}`
      : `/kb/${kbId}/documents/${docId}?view=pdf`;
    router.push(url);
    previewChunk.value = null;
  }
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>