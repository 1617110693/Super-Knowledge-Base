<template>
  <div class="tool-call-cards">
    <el-collapse v-model="activeNames">
      <el-collapse-item
        v-for="tc in toolCalls"
        :key="tc.id"
        :name="tc.id"
        :title="toolName(tc)"
      >
        <div class="tool-call-details">
          <!-- Arguments -->
          <div class="tool-section">
            <div class="tool-section-label text-xs font-medium text-gray-500 mb-1">{{ t("tool.args") }}</div>
            <pre class="tool-json">{{ prettyArgs(tc) }}</pre>
          </div>
          <!-- Result -->
          <div v-if="tc.id && toolResults[tc.id]" class="tool-section">
            <div class="tool-section-label text-xs font-medium text-gray-500 mb-1">{{ t("tool.result") }}</div>
            <pre class="tool-json tool-result">{{ toolResults[tc.id] }}</pre>
          </div>
          <!-- Loading state -->
          <div v-else-if="isExecuting(tc)" class="tool-loading">
            <LoadingIcon class="w-4 h-4 animate-spin" />
            <span class="text-xs text-gray-400 ml-2">Executing...</span>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Loader2 as LoadingIcon } from "lucide-vue-next";
import type { ToolCall } from "@/types";
import { toolLabel } from "@/services/toolDefinitions";
import { useI18n } from "@/i18n/index";

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    toolCalls: ToolCall[];
    toolResults?: Record<string, string>;
    executingIds?: string[];
  }>(),
  { toolResults: () => ({}), executingIds: () => [] }
);

const activeNames = ref<string[]>([]);

function toolName(tc: ToolCall): string {
  return toolLabel(tc);
}

function prettyArgs(tc: ToolCall): string {
  try {
    const parsed = JSON.parse(tc.function.arguments);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return tc.function.arguments || "{}";
  }
}

function isExecuting(tc: ToolCall): boolean {
  return props.executingIds.includes(tc.id);
}
</script>

<style scoped>
.tool-call-cards {
  @apply my-2;
}

.tool-call-cards :deep(.el-collapse-item__header) {
  @apply text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50
         px-3 h-8 rounded-t-md;
}

.tool-call-cards :deep(.el-collapse-item__wrap) {
  @apply border border-gray-200 dark:border-gray-700 border-t-0 rounded-b-md;
}

.tool-call-cards :deep(.el-collapse-item__content) {
  @apply px-3 py-2;
}

.tool-section {
  @apply mb-2 last:mb-0;
}

.tool-json {
  @apply bg-gray-50 dark:bg-gray-900 rounded p-2 text-xs font-mono
         text-gray-700 dark:text-gray-300 overflow-x-auto max-h-40 overflow-y-auto;
}

.tool-result {
  @apply max-h-60;
}

.tool-loading {
  @apply flex items-center py-2;
}
</style>
