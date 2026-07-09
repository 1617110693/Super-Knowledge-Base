<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { search } from "@/services/pythonClient";
import type { SearchResult, SearchRequest } from "@/types";
import {
  Search,
  Settings2,
  SlidersHorizontal,
  RotateCcw,
  FileText,
  Hash,
  ExternalLink,
  X,
  Loader2,
} from "lucide-vue-next";

const props = withDefaults(
  defineProps<{
    kbId?: string;
  }>(),
  { kbId: undefined }
);

const route = useRoute();
const router = useRouter();

const resolvedKbId = computed(() => props.kbId || (route.params.kbId as string));

const query = ref("");
const searchType = ref<"hybrid" | "vector" | "fts">("hybrid");
const topK = ref(10);
const rerank = ref(true);
const contextWindow = ref(1);

const results = ref<SearchResult[]>([]);
const total = ref(0);
const searchTimeMs = ref(0);
const searching = ref(false);
const searched = ref(false);
const error = ref<string | null>(null);

// Chunk detail dialog
const showChunkDetail = ref(false);
const selectedChunk = ref<SearchResult | null>(null);
const chunkContent = ref("");
const chunkLoading = ref(false);

// Validate params
watch(resolvedKbId, () => {
  results.value = [];
  searched.value = false;
  error.value = null;
});

async function doSearch() {
  const kbId = resolvedKbId.value;
  if (!kbId || !query.value.trim()) return;

  searching.value = true;
  searched.value = false;
  error.value = null;
  results.value = [];
  total.value = 0;

  const req: SearchRequest = {
    kb_id: kbId,
    query: query.value.trim(),
    search_type: searchType.value,
    top_k: topK.value,
    rerank: rerank.value,
    context_window: contextWindow.value,
  };

  try {
    const res = await search(req);
    results.value = res.results;
    total.value = res.total;
    searchTimeMs.value = res.search_time_ms;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    searching.value = false;
    searched.value = true;
  }
}

function openChunkDetail(result: SearchResult) {
  selectedChunk.value = result;
  chunkContent.value = result.content;
  showChunkDetail.value = true;
}

function navigateToDocument(result: SearchResult) {
  const kbId = resolvedKbId.value;
  if (kbId && result.doc_id) {
    router.push(`/kb/${kbId}/documents/${result.doc_id}`);
  }
}

function truncate(text: string, max = 300): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function scoreColor(score: number): string {
  if (score >= 0.7) return "var(--el-color-success)";
  if (score >= 0.4) return "var(--el-color-warning)";
  return "var(--el-color-danger)";
}
</script>

<template>
  <div class="search-interface">
    <!-- Search Form -->
    <div class="search-form">
      <div class="search-row">
        <el-input
          v-model="query"
          placeholder="Search documents in this knowledge base..."
          clearable
          size="large"
          @keydown.enter="doSearch"
        >
          <template #prefix>
            <Search :size="18" class="input-icon" />
          </template>
          <template #append>
            <el-button
              type="primary"
              :loading="searching"
              @click="doSearch"
            >
              <template v-if="!searching">
                <Search :size="16" style="margin-right: 4px" />
                Search
              </template>
              <template v-else>
                <Loader2 :size="16" class="spin" style="margin-right: 4px" />
                Searching
              </template>
            </el-button>
          </template>
        </el-input>
      </div>

      <div class="search-options">
        <div class="option-item">
          <label class="option-label">
            <Settings2 :size="14" />
            Search Type
          </label>
          <el-select v-model="searchType" size="small" style="width: 140px">
            <el-option label="Hybrid (Vector + FTS)" value="hybrid" />
            <el-option label="Vector Only" value="vector" />
            <el-option label="Full-Text Only" value="fts" />
          </el-select>
        </div>

        <div class="option-item">
          <label class="option-label">
            <Hash :size="14" />
            Top-K ({{ topK }})
          </label>
          <el-slider
            v-model="topK"
            :min="3"
            :max="50"
            :step="1"
            show-input
            size="small"
            input-size="small"
            style="width: 200px"
          />
        </div>

        <div class="option-item">
          <label class="option-label">
            <RotateCcw :size="14" />
            Rerank
          </label>
          <el-switch v-model="rerank" size="small" />
        </div>

        <div class="option-item">
          <label class="option-label">
            <SlidersHorizontal :size="14" />
            Context Window ({{ contextWindow }})
          </label>
          <el-slider
            v-model="contextWindow"
            :min="0"
            :max="5"
            :step="1"
            show-input
            size="small"
            input-size="small"
            style="width: 140px"
          />
        </div>
      </div>
    </div>

    <!-- Results -->
    <div class="search-results-area">
      <!-- Error -->
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        show-icon
        closable
        class="mb-3"
      />

      <!-- Summary -->
      <div v-if="searched && !error" class="result-summary">
        Found <strong>{{ total }}</strong> result{{ total !== 1 ? "s" : "" }}
        in {{ (searchTimeMs / 1000).toFixed(2) }}s
      </div>

      <!-- Loading -->
      <div v-if="searching" class="loading-state">
        <el-skeleton :rows="5" animated />
      </div>

      <!-- Empty -->
      <el-empty
        v-else-if="searched && results.length === 0"
        description="No results found. Try adjusting search parameters."
        :image-size="80"
      />

      <!-- Results List -->
      <div v-else-if="results.length > 0" class="results-list">
        <div
          v-for="(result, idx) in results"
          :key="result.chunk_id || idx"
          class="result-card"
          @click="openChunkDetail(result)"
        >
          <div class="result-header">
            <span class="result-title" @click.stop="navigateToDocument(result)">
              <FileText :size="14" />
              {{ result.doc_name || "Untitled" }}
            </span>
            <el-tag
              :style="{
                backgroundColor: scoreColor(result.score),
                borderColor: scoreColor(result.score),
                color: '#fff',
                fontSize: '11px',
              }"
              size="small"
            >
              {{ (result.score * 100).toFixed(1) }}%
            </el-tag>
          </div>
          <div class="result-content">
            {{ truncate(result.content, 400) }}
          </div>
          <div class="result-footer">
            <span v-if="result.page_start != null" class="page-info">
              Page {{ result.page_start }}{{ result.page_end != null && result.page_end !== result.page_start ? `-${result.page_end}` : "" }}
            </span>
            <button class="view-doc-btn" @click.stop="navigateToDocument(result)">
              <ExternalLink :size="12" />
              Open Document
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Chunk Detail Dialog -->
    <el-dialog
      v-model="showChunkDetail"
      title="Chunk Detail"
      width="700px"
      top="5vh"
      destroy-on-close
    >
      <template v-if="selectedChunk">
        <div class="chunk-meta">
          <el-descriptions :column="2" size="small" border>
            <el-descriptions-item label="Document">
              {{ selectedChunk.doc_name }}
            </el-descriptions-item>
            <el-descriptions-item label="Score">
              <el-tag
                :style="{
                  backgroundColor: scoreColor(selectedChunk.score),
                  borderColor: scoreColor(selectedChunk.score),
                  color: '#fff',
                }"
                size="small"
              >
                {{ (selectedChunk.score * 100).toFixed(1) }}%
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item
              v-if="selectedChunk.page_start != null"
              label="Page"
            >
              {{ selectedChunk.page_start }}
              {{ selectedChunk.page_end != null && selectedChunk.page_end !== selectedChunk.page_start ? `- ${selectedChunk.page_end}` : "" }}
            </el-descriptions-item>
            <el-descriptions-item
              v-if="selectedChunk.metadata?.chunk_index != null"
              label="Chunk Index"
            >
              {{ selectedChunk.metadata.chunk_index }}
            </el-descriptions-item>
          </el-descriptions>
        </div>
        <div class="chunk-content">
          <pre>{{ selectedChunk.content }}</pre>
        </div>
      </template>
      <template #footer>
        <el-button @click="showChunkDetail = false">Close</el-button>
        <el-button
          v-if="selectedChunk"
          type="primary"
          @click="navigateToDocument(selectedChunk); showChunkDetail = false"
        >
          <ExternalLink :size="14" style="margin-right: 4px" />
          Open Document
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.search-interface {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
}

.search-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--el-bg-color);
  border-radius: var(--el-border-radius-base);
  border: 1px solid var(--el-border-color-light);
}

.search-row {
  display: flex;
  gap: 8px;
}

.search-row .el-input {
  flex: 1;
}

.input-icon {
  color: var(--el-text-color-placeholder);
}

.search-options {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}

.option-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.option-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.search-results-area {
  flex: 1;
  overflow-y: auto;
  padding: 0 4px;
}

.result-summary {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
  padding: 0 4px;
}

.loading-state {
  padding: 24px 0;
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.result-card {
  padding: 12px 14px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
  cursor: pointer;
  transition: all 0.15s ease;
}

.result-card:hover {
  border-color: var(--el-color-primary);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.result-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.result-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  word-break: break-word;
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.result-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.page-info {
  font-size: 11px;
  color: var(--el-text-color-disabled);
  font-family: monospace;
}

.view-doc-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--el-color-info);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background 0.15s;
}

.view-doc-btn:hover {
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
}

/* Chunk Detail Dialog */
.chunk-meta {
  margin-bottom: 16px;
}

.chunk-content {
  max-height: 500px;
  overflow-y: auto;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
  padding: 12px;
}

.chunk-content pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.mb-3 {
  margin-bottom: 12px;
}
</style>
