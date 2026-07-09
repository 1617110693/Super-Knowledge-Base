<template>
  <div ref="listContainer" class="message-list-container">
    <div
      ref="virtualizerContainer"
      class="virtual-list"
      :style="{ height: `${virtualizer.getTotalSize()}px` }"
    >
      <div
        v-for="vRow in virtualizer.getVirtualItems()"
        :key="String(vRow.key)"
        class="virtual-row"
        :style="{
          transform: `translateY(${vRow.start}px)`,
        }"
      >
        <MessageRow
          :msg="visibleMessages[vRow.index]"
          :index="vRow.index"
          :is-streaming="isStreaming && vRow.index === visibleMessages.length - 1 && visibleMessages[vRow.index].role === 'assistant'"
          :is-last="vRow.index === visibleMessages.length - 1"
          :streaming="streaming"
          :tool-results="toolResults"
          :active-tool-id="activeToolId"
          :copied-msg-idx="copiedMsgIdx"
          @source-click="(src: any) => $emit('sourceClick', src)"
          @copy="(content: string, idx: number) => $emit('copy', content, idx)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import type { ChatMessage, SearchResult } from "@/types";
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
  copy: [content: string, idx: number];
  toggleAutoScroll: [];
}>();

const listContainer = ref<HTMLDivElement | null>(null);
const virtualizerContainer = ref<HTMLDivElement | null>(null);

const visibleMessages = computed(() =>
  props.messages.filter((m) => m.role !== "tool")
);

const isStreaming = computed(() => props.streaming);

const messageCount = computed(() => visibleMessages.value.length);
const virtualizer = useVirtualizer({
  get count() { return messageCount.value; },
  getScrollElement: () => props.scrollRef || listContainer.value,
  estimateSize: (i: number) => {
    const m = visibleMessages.value[i];
    if (!m) return 120;
    if (m.role === "user") return 60;
    if (m.tool_calls) return 140;
    return 160;
  },
  overscan: 3,
}) as any;

// Auto-scroll to bottom during streaming or when autoScroll is true
const prevLenRef = ref(visibleMessages.value.length);
const prevContentRef = ref(props.messages[props.messages.length - 1]?.content);

watch(
  () => [visibleMessages.value.length, props.messages[props.messages.length - 1]?.content, props.streaming] as const,
  () => {
    if (visibleMessages.value.length === 0) return;

    const lastMsg = props.messages[props.messages.length - 1];
    const contentChanged = lastMsg?.content !== prevContentRef.value;
    const lenChanged = visibleMessages.value.length !== prevLenRef.value;

    prevLenRef.value = visibleMessages.value.length;
    prevContentRef.value = lastMsg?.content;

    if (!lenChanged && !contentChanged) return;
    if (!props.autoScroll && !props.streaming) return;

    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          virtualizer.scrollToIndex(visibleMessages.value.length - 1, { align: "end" });
        } catch {
          // scrollToIndex may throw if the virtualizer hasn't initialized yet
        }
      });
    });
    return () => cancelAnimationFrame(raf);
  }
);

// Trigger initial scroll to bottom on mount
onMounted(() => {
  if (visibleMessages.value.length > 1) {
    requestAnimationFrame(() => {
      try {
        virtualizer.scrollToIndex(visibleMessages.value.length - 1, { align: "end" });
      } catch {
        // scrollToIndex may throw if the virtualizer hasn't initialized yet
      }
    });
  }
});
</script>

<style scoped>
.message-list-container {
  @apply flex-1 relative;
}

.virtual-list {
  @apply relative w-full;
}

.virtual-row {
  @apply absolute left-0 right-0;
}
</style>