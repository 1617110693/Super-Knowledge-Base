<template>
  <div class="sources-panel" v-if="sources.length > 0">
    <el-collapse v-model="activePanels">
      <el-collapse-item :title="`${sourcesLabel || 'Sources'} (${sources.length})`" name="sources">
        <div class="sources-list">
          <div
            v-for="(src, idx) in sources"
            :key="src.chunk_id || idx"
            class="source-item"
            @click="$emit('sourceClick', src)"
          >
            <div class="source-header">
              <span class="source-doc-name text-xs font-medium truncate">
                {{ src.doc_name || `Source ${idx + 1}` }}
              </span>
              <span class="source-chunk text-xs text-gray-400">
                #{{ src.metadata?.chunk_index ?? "-" }}
              </span>
            </div>
            <div class="source-score-row">
              <el-progress
                :percentage="normalizedScore(src.score)"
                :stroke-width="4"
                color="#409eff"
                :show-text="false"
                class="source-progress"
              />
              <span class="source-score-value text-xs text-gray-400 ml-2">
                {{ (src.score * 100).toFixed(0) }}%
              </span>
            </div>
            <div class="source-preview text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
              {{ truncateContent(src.content) }}
            </div>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { SearchResult } from "@/types";

defineProps<{
  sources: SearchResult[];
  sourcesLabel?: string;
}>();

defineEmits<{
  sourceClick: [source: SearchResult];
}>();

const activePanels = ref<string[]>([]);

function normalizedScore(score: number): number {
  return Math.min(Math.max(Math.round((score || 0) * 100), 0), 100);
}

function truncateContent(content: string, maxLen = 150): string {
  if (!content) return "";
  return content.length > maxLen ? content.slice(0, maxLen) + "..." : content;
}
</script>

<style scoped>
.sources-panel {
  @apply mt-2;
}

.sources-panel :deep(.el-collapse-item__header) {
  @apply text-xs font-medium text-gray-500 dark:text-gray-400 px-3 h-8;
  border-radius: var(--radius);
}

.sources-panel :deep(.el-collapse-item__wrap) {
  @apply border-none;
}

.sources-panel :deep(.el-collapse-item__content) {
  @apply px-3 pb-2;
}

.sources-list {
  @apply flex flex-col gap-2 max-h-60 overflow-y-auto;
}

.source-item {
  @apply p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 cursor-pointer
         hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors;
}

.source-header {
  @apply flex items-center justify-between mb-1;
}

.source-score-row {
  @apply flex items-center mb-1;
}

.source-progress {
  @apply flex-1;
}

.source-preview {
  @apply leading-relaxed;
}
</style>
