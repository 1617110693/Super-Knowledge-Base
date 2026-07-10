<script setup lang="ts">
import { computed } from "vue";
import type { SearchResult } from "@/types";
import MarkdownRenderer from "@/components/common/MarkdownRenderer.vue";
import { FileText, Hash, BookOpen, Layers, ArrowLeft, ArrowRight } from "lucide-vue-next";

const props = defineProps<{
  visible: boolean;
  chunk: SearchResult | null;
}>();

const emit = defineEmits<{
  (e: "update:visible", val: boolean): void;
  (e: "openDocument", docId: string): void;
  (e: "prev"): void;
  (e: "next"): void;
}>();

const hasPrev = computed(() => !!props.chunk?.context?.prev?.length);
const hasNext = computed(() => !!props.chunk?.context?.next?.length);
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="Chunk Detail"
    width="640px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
  >
    <div v-if="chunk" class="chunk-detail">
      <!-- Metadata -->
      <div class="chunk-meta">
        <div class="meta-row">
          <div class="meta-item" v-if="chunk.doc_name">
            <FileText :size="14" />
            <span class="meta-label">Document:</span>
            <button
              class="meta-link"
              @click="emit('openDocument', chunk.doc_id)"
            >
              {{ chunk.doc_name }}
            </button>
          </div>
          <div class="meta-item" v-if="chunk.metadata?.chunk_index !== undefined">
            <Layers :size="14" />
            <span class="meta-label">Chunk:</span>
            <span>{{ chunk.metadata.chunk_index }}</span>
          </div>
        </div>
        <div class="meta-row">
          <div class="meta-item" v-if="chunk.metadata?.page">
            <BookOpen :size="14" />
            <span class="meta-label">Page:</span>
            <span>{{ chunk.metadata.page }}</span>
          </div>
          <div class="meta-item" v-if="chunk.score !== undefined">
            <Hash :size="14" />
            <span class="meta-label">Score:</span>
            <span>{{ (chunk.score * 100).toFixed(1) }}%</span>
          </div>
        </div>
      </div>

      <!-- Content -->
      <div class="chunk-content">
        <MarkdownRenderer :content="chunk.content" />
      </div>

      <!-- Navigation -->
      <div class="chunk-nav" v-if="hasPrev || hasNext">
        <el-button size="small" :disabled="!hasPrev" @click="emit('prev')">
          <ArrowLeft :size="14" style="margin-right: 4px" />
          Previous
        </el-button>
        <el-button size="small" :disabled="!hasNext" @click="emit('next')">
          Next
          <ArrowRight :size="14" style="margin-left: 4px" />
        </el-button>
      </div>
    </div>

    <div v-else class="chunk-empty">
      <p>Select a chunk to view details</p>
    </div>
  </el-dialog>
</template>

<style scoped>
.chunk-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.chunk-meta {
  background: var(--surface-raised);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.meta-label {
  color: var(--text-primary);
  font-weight: 500;
}

.meta-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent-color);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.meta-link:hover {
  text-decoration: underline;
}

.chunk-content {
  max-height: 400px;
  overflow-y: auto;
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.chunk-nav {
  display: flex;
  justify-content: space-between;
}

.chunk-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: var(--text-secondary);
}
</style>
