<template>
  <div class="message-list">
    <div
      v-for="(msg, idx) in visibleMessages"
      :key="idx"
      class="message-row"
    >
      <MessageRow
        :msg="msg"
        :index="idx"
        :is-streaming="isStreaming && idx === visibleMessages.length - 1 && visibleMessages[idx].role === 'assistant'"
        :is-last="idx === visibleMessages.length - 1"
        :streaming="streaming"
        :tool-results="toolResults"
        :active-tool-id="activeToolId"
        :copied-msg-idx="copiedMsgIdx"
        @source-click="(src: any) => $emit('sourceClick', src)"
        @web-source-click="(src: any) => $emit('webSourceClick', src)"
        @copy="(content: string, idx: number) => $emit('copy', content, idx)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted } from "vue";
import type { ChatMessage, SearchResult, WebSearchSource } from "@/types";
import MessageRow from "./MessageRow.vue";

const props = withDefaults(
  defineProps<{
    messages: ChatMessage[];
    streaming?: boolean;
    toolResults?: Record<string, string>;
    activeToolId?: string | null;
    copiedMsgIdx?: number | null;
    autoScroll?: boolean;
    scrollRef?: HTMLElement | null;
  }>(),
  {
    streaming: false,
    toolResults: () => ({}),
    activeToolId: null,
    copiedMsgIdx: null,
    autoScroll: true,
    scrollRef: null,
  }
);

defineEmits<{
  sourceClick: [source: SearchResult];
  webSourceClick: [source: WebSearchSource];
  copy: [content: string, idx: number];
  toggleAutoScroll: [];
}>();

const visibleMessages = computed(() =>
  props.messages.filter((m) => m.role !== "tool")
);

const isStreaming = computed(() => props.streaming);

// Auto-scroll to bottom when messages change or during streaming
const prevLenRef = ref(visibleMessages.value.length);
const prevContentRef = ref(props.messages[props.messages.length - 1]?.content);

watch(
  () => [visibleMessages.value.length, props.messages[props.messages.length - 1]?.content, props.streaming] as const,
  () => {
    const lastMsg = props.messages[props.messages.length - 1];
    const contentChanged = lastMsg?.content !== prevContentRef.value;
    const lenChanged = visibleMessages.value.length !== prevLenRef.value;

    prevLenRef.value = visibleMessages.value.length;
    prevContentRef.value = lastMsg?.content;

    if (!lenChanged && !contentChanged) return;
    if (!props.autoScroll && !props.streaming) return;

    nextTick(() => {
      const el = props.scrollRef;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    });
  }
);

// Trigger initial scroll to bottom on mount
onMounted(() => {
  if (visibleMessages.value.length > 0) {
    nextTick(() => {
      const el = props.scrollRef;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    });
  }
});
</script>

<style scoped>
.message-list {
  @apply flex flex-col gap-3;
}

.message-row {
  @apply shrink-0;
}
</style>