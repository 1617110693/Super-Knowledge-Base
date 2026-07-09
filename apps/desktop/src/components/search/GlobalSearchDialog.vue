<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { searchAll } from "@/services/pythonClient";
import { listKBs } from "@/services/tauriBridge";
import type { SearchResult, KnowledgeBase } from "@/types";
import {
  Search,
  X,
  Loader2,
  Database,
  FileText,
  ExternalLink,
  BookOpen,
} from "lucide-vue-next";
import { useI18n } from "@/i18n/index";

const { t } = useI18n();
const router = useRouter();

const visible = ref(false);
const query = ref("");
const selectedKbIds = ref<string[]>([]);
const kbList = ref<KnowledgeBase[]>([]);
const results = ref<SearchResult[]>([]);
const total = ref(0);
const searching = ref(false);
const error = ref<string | null>(null);

async function loadKBs() {
  try {
    kbList.value = await listKBs();
  } catch {
    kbList.value = [];
  }
}

async function doSearch() {
  if (!query.value.trim()) return;

  searching.value = true;
  error.value = null;
  results.value = [];
  total.value = 0;

  try {
    const res = await searchAll({
      kb_ids: selectedKbIds.value.length > 0 ? selectedKbIds.value : undefined,
      query: query.value.trim(),
      search_type: "hybrid",
      top_k: 10,
      rerank: true,
    });
    results.value = res.results;
    total.value = res.total;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    searching.value = false;
  }
}

function open() {
  visible.value = true;
  loadKBs();
  // Re-trigger search on next tick after dialog opens
  setTimeout(() => {
    if (query.value.trim()) doSearch();
  }, 100);
}

function close() {
  visible.value = false;
}

function navigateToDocument(result: SearchResult) {
  close();
  router.push(`/kb/${result.kb_id}/documents/${result.doc_id}`);
}

function getKbName(kbId: string): string {
  return kbList.value.find((kb) => kb.id === kbId)?.name || kbId;
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function scoreBadgeType(score: number): string {
  if (score >= 0.7) return "success";
  if (score >= 0.4) return "warning";
  return "danger";
}

// ── Keyboard shortcut: Ctrl+K / Cmd+K ──
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    e.stopPropagation();
    open();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
});

// Expose open/close for external trigger
defineExpose({ open, close });
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="t('search.searchAllTitle')"
    width="700px"
    top="8vh"
    :close-on-click-modal="true"
    :close-on-press-escape="true"
    destroy-on-close
    class="global-search-dialog"
  >
    <div class="global-search-body">
      <!-- Search Input -->
      <div class="search-bar">
        <el-input
          ref="searchInputRef"
          v-model="query"
          :placeholder="t('search.searchAllPlaceholder')"
          size="large"
          clearable
          autofocus
          @keydown.enter="doSearch"
        >
          <template #prefix>
            <Search :size="18" class="input-icon" />
          </template>
        </el-input>
      </div>

      <!-- KB Filter -->
      <div class="filter-bar">
        <div class="filter-label">
          <Database :size="14" />
          <span>{{ t('search.knowledgeBases') || "Knowledge Bases" }}</span>
        </div>
        <el-select
          v-model="selectedKbIds"
          multiple
          :placeholder="t('search.allKbsPlaceholder') || 'All KBs (leave empty to search all)'"
          size="small"
          clearable
          collapse-tags
          collapse-tags-tooltip
          style="flex: 1"
        >
          <el-option
            v-for="kb in kbList"
            :key="kb.id"
            :label="kb.name"
            :value="kb.id"
          />
        </el-select>
      </div>

      <!-- Error -->
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        show-icon
        closable
        class="mb-2"
      />

      <!-- Results -->
      <div class="search-results-area">
        <!-- Summary -->
        <div v-if="!searching && results.length > 0" class="result-summary">
          {{ t("search.results", { count: total, time: 0 }) }}
        </div>

        <!-- Loading -->
        <div v-if="searching" class="loading-state">
          <div v-for="n in 4" :key="n" class="skeleton-row">
            <el-skeleton animated />
          </div>
        </div>

        <!-- Empty -->
        <el-empty
          v-else-if="query && !searching && results.length === 0 && !error"
          :description="t('search.noResultsFound') || 'No results found across knowledge bases.'"
          :image-size="60"
        />

        <!-- Results List -->
        <div v-else-if="results.length > 0" class="results-list">
          <div
            v-for="(result, idx) in results"
            :key="result.chunk_id || idx"
            class="global-result-card"
            @click="navigateToDocument(result)"
          >
            <div class="result-header">
              <div class="result-location">
                <span class="kb-badge">
                  <Database :size="12" />
                  {{ getKbName(result.kb_id) }}
                </span>
                <span class="doc-name">
                  <FileText :size="12" />
                  {{ result.doc_name || (t("search.untitled") || "Untitled") }}
                </span>
              </div>
              <el-tag
                :type="scoreBadgeType(result.score)"
                size="small"
                effect="dark"
              >
                {{ (result.score * 100).toFixed(1) }}%
              </el-tag>
            </div>
            <div class="result-content">
              {{ truncate(result.content, 250) }}
            </div>
            <div class="result-footer">
              <span
                v-if="result.page_start != null"
                class="page-info"
              >
                <BookOpen :size="11" />
                p.{{ result.page_start }}
                {{ result.page_end != null && result.page_end !== result.page_start ? `-${result.page_end}` : "" }}
              </span>
              <span class="open-hint">
                <ExternalLink :size="11" />
                {{ t("search.openDocument") || "Open document" }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.global-search-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 200px;
}

.search-bar {
  width: 100%;
}

.input-icon {
  color: var(--el-text-color-placeholder);
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.filter-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  font-weight: 500;
}

.search-results-area {
  flex: 1;
  overflow-y: auto;
  max-height: 400px;
}

.result-summary {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}

.loading-state {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skeleton-row {
  padding: 12px;
  border-radius: var(--el-border-radius-base);
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.global-result-card {
  padding: 10px 12px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
  cursor: pointer;
  transition: all 0.15s ease;
}

.global-result-card:hover {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary);
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  gap: 8px;
}

.result-location {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.kb-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
}

.doc-name {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-content {
  font-size: 13px;
  line-height: 1.5;
  color: var(--el-text-color-regular);
  word-break: break-word;
  margin-bottom: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.result-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.page-info,
.open-hint {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--el-text-color-disabled);
}

.open-hint {
  color: var(--el-color-info);
  opacity: 0;
  transition: opacity 0.15s;
}

.global-result-card:hover .open-hint {
  opacity: 1;
}

.mb-2 {
  margin-bottom: 8px;
}

:deep(.el-dialog__body) {
  padding: 12px 20px;
}
</style>
