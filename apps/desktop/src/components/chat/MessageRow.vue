<template>
  <div class="flex gap-3 group" :class="{ 'flex-row-reverse': msg.role === 'user' }">
    <!-- Assistant avatar -->
    <div v-if="msg.role === 'assistant'" class="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
      <Bot class="w-4 h-4 text-primary" />
    </div>
    <!-- User avatar -->
    <div v-if="msg.role === 'user'" class="w-7 h-7 rounded-full bg-primary flex items-center justify-center shrink-0 mt-1">
      <User class="w-4 h-4 text-primary-foreground" />
    </div>

    <div class="relative max-w-[80%]" :class="msg.role === 'user' ? 'items-end' : 'items-start'">
      <div
        class="rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm"
        :class="msg.role === 'user'
          ? 'bg-primary text-primary-foreground rounded-br-md'
          : 'bg-card border border-border/50 rounded-bl-md'"
      >
        <!-- Reasoning / thinking block -->
        <ThinkingBlock
          v-if="msg.role === 'assistant' && msg.reasoning"
          :reasoning="msg.reasoning"
          :is-streaming="isStreaming"
        />

        <!-- Assistant content with markdown -->
        <ChatMarkdown
          v-if="msg.role === 'assistant' && msg.content"
          :content="msg.content"
          :is-streaming="isStreaming"
          :sources="msg.sources"
          :web-sources="msg.webSources"
          @source-click="(s: any) => $emit('sourceClick', s)"
          @web-source-click="(s: any) => $emit('webSourceClick', s)"
        />

        <!-- Tool calls -->
        <ToolCallCards
          v-if="msg.role === 'assistant' && msg.tool_calls"
          :tool-calls="msg.tool_calls"
          :tool-results="toolResults"
          :executing-ids="activeToolId ? [activeToolId] : []"
        />

        <!-- Loading spinner during streaming -->
        <Loader2 v-else-if="msg.role === 'assistant' && streaming && isLast" class="w-3 h-3 animate-spin inline" />

        <!-- Plain text (user messages or assistant without content/tool_calls fallback) -->
        <div v-if="msg.role === 'user'" class="whitespace-pre-wrap break-words">{{ msg.content }}</div>
        <div v-else-if="msg.role === 'assistant' && !msg.tool_calls && !msg.content" class="whitespace-pre-wrap break-words">{{ msg.content }}</div>
      </div>

      <!-- Copy button -->
      <button
        v-if="msg.content"
        class="opacity-0 group-hover:opacity-100 transition-opacity mt-1 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        :class="msg.role === 'user' ? 'mr-2' : 'ml-2'"
        title="Copy"
        @click="$emit('copy', msg.content, index)"
      >
        <Check v-if="copiedMsgIdx === index" class="w-3.5 h-3.5 text-green-500" />
        <Copy v-else class="w-3.5 h-3.5" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Bot, User, Copy, Check, Loader2 } from "lucide-vue-next";
import type { ChatMessage, SearchResult, WebSearchSource } from "@/types";
import ChatMarkdown from "./ChatMarkdown.vue";
import ToolCallCards from "./ToolCallCards.vue";
import ThinkingBlock from "./ThinkingBlock.vue";

defineProps<{
  msg: ChatMessage;
  index: number;
  isStreaming: boolean;
  isLast: boolean;
  streaming: boolean;
  toolResults: Record<string, string>;
  activeToolId: string | null;
  copiedMsgIdx: number | null;
}>();

defineEmits<{
  sourceClick: [source: SearchResult];
  webSourceClick: [source: WebSearchSource];
  copy: [content: string, idx: number];
}>();
</script>