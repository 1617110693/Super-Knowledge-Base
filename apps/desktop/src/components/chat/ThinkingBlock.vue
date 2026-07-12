<template>
  <div class="mb-2 border rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800/40 border-gray-200 dark:border-gray-700">
    <button
      class="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
      @click="open = !open"
    >
      <Loader2 v-if="isStreaming" class="w-3 h-3 animate-spin shrink-0" />
      <ChevronDown v-else class="w-3 h-3 shrink-0 transition-transform" :class="{ '-rotate-90': !open }" />
      <span v-if="isStreaming">Thinking...</span>
      <span v-else>Thought process</span>
    </button>
    <div v-if="open" ref="scrollRef" class="max-h-48 overflow-y-auto px-3 py-2 border-t border-gray-200 dark:border-gray-700">
      <div class="text-xs text-muted-foreground whitespace-pre-wrap break-words leading-relaxed">{{ reasoning }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { Loader2, ChevronDown } from "lucide-vue-next";

const props = defineProps<{
  reasoning: string;
  isStreaming: boolean;
}>();

const open = ref(true);
const scrollRef = ref<HTMLDivElement | null>(null);

watch(
  () => props.reasoning,
  () => {
    nextTick(() => {
      if (scrollRef.value) {
        scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
      }
    });
  }
);

watch(
  () => props.isStreaming,
  (val) => {
    if (val) open.value = true;
  }
);
</script>