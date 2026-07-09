<template>
  <div class="flex gap-3 group" :class="{ 'justify-end': msg.role === 'user' }">
    <!-- Assistant avatar -->
    <div v-if="msg.role === 'assistant'" class="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
      <Bot class="w-4 h-4 text-primary" />
    </div>

    <div class="relative max-w-[80%]">
      <div
        class="rounded-xl px-4 py-2.5 text-sm"
        :class="msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'"
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
          @source-click="(s: any) => $emit('sourceClick', s)"
        />

        <!-- Tool calls without content -->
        <ToolCallCards
          v-else-if="msg.role === 'assistant' && msg.tool_calls && !msg.content"
          :tool-calls="msg.tool_calls"
          :tool-results="toolResults"
          :executing-ids="activeToolId ? [activeToolId] : []"
        />

        <!-- Loading spinner during streaming -->
        <Loader2 v-else-if="msg.role === 'assistant' && streaming && isLast" class="w-3 h-3 animate-spin inline" />

        <!-- Plain text (user messages or fallback) -->
        <div v-else class="whitespace-pre-wrap break-words">{{ msg.content }}</div>
      </div>

      <!-- Copy button -->
      <button
        v-if="msg.content"
        class="absolute bottom-1 hidden group-hover:flex p-1 rounded hover:bg-muted text-muted-foreground transition-colors"
        :class="msg.role === 'user' ? '-left-8' : '-right-8'"
        title="Copy"
        @click="$emit('copy', msg.content, index)"
      >
        <Check v-if="copiedMsgIdx === index" class="w-3.5 h-3.5 text-green-500" />
        <Copy v-else class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- User avatar -->
    <div v-if="msg.role === 'user'" class="w-7 h-7 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5">
      <User class="w-4 h-4 text-primary-foreground" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { Bot, User, Copy, Check, Loader2 } from "lucide-vue-next";
import type { ChatMessage } from "@/types";
import ChatMarkdown from "./ChatMarkdown.vue";
import ToolCallCards from "./ToolCallCards.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import type { SearchResult } from "@/types";

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
  copy: [content: string, idx: number];
}>();
</script>