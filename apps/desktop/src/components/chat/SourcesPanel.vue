<template>
  <div class="sources-panel" v-if="sources.length > 0 || webSources.length > 0">
    <el-collapse v-model="activePanels">
      <!-- Knowledge Base Sources -->
      <el-collapse-item
        v-if="sources.length > 0"
        :title="`${sourcesLabel || 'Sources'} (${sources.length})`"
        name="sources"
      >
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

      <!-- Web Search Sources -->
      <el-collapse-item
        v-if="webSources.length > 0"
        :title="`${webSourcesLabel || 'Web Results'} (${webSources.length})`"
        name="web-sources"
      >
        <div class="sources-list">
          <div
            v-for="(src, idx) in webSources"
            :key="src.url || idx"
            class="source-item web-source-item"
            @click="$emit('webSourceClick', src)"
          >
            <div class="source-header">
              <span class="source-doc-name text-xs font-medium truncate web-source-title">
                <Globe :size="11" class="inline-block mr-1 shrink-0" />
                {{ src.title || `Result ${idx + 1}` }}
              </span>
              <span class="web-source-index text-xs">
                W{{ idx + 1 }}
              </span>
            </div>
            <div class="web-source-url text-xs text-gray-400 truncate">
              {{ src.url }}
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
import { Globe } from "lucide-vue-next";
import type { SearchResult, WebSearchSource } from "@/types";

const props = defineProps<{
  sources: SearchResult[];
  webSources?: WebSearchSource[];
  sourcesLabel?: string;
  webSourcesLabel?: string;
}>();

defineEmits<{
  sourceClick: [source: SearchResult];
  webSourceClick: [source: WebSearchSource];
}>();

const activePanels = ref<string[]>(["sources", "web-sources"]);

function normalizedScore(score: number): number {
  return Math.min(Math.max(Math.round((score || 0) * 100), 0), 100);
}

function truncateContent(content: string, maxLen = 150): string {
  if (!content) return "";
  return content.length > maxLen ? content.slice(0, maxLen) + "..." : content;
}

// Ensure webSources has a default
const webSources = props.webSources || [];
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

/* Web source specific styles */
.web-source-item {
  @apply border-l-2 border-sky-200 dark:border-sky-800;
}

.web-source-title {
  @apply inline-flex items-center text-sky-700 dark:text-sky-400;
}

.web-source-index {
  @apply text-sky-500 dark:text-sky-400 font-mono font-semibold;
  flex-shrink: 0;
  margin-left: 4px;
}

.web-source-url {
  @apply mb-1;
}
</style>
