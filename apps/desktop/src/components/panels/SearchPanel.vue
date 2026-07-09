<script setup lang="ts">
import { ref } from "vue";
import { useDocumentStore } from "@/stores/document";
import { PhMagnifyingGlass } from "@phosphor-icons/vue";
import { useI18n } from "@/composables/useI18n";

const doc = useDocumentStore();
const { t } = useI18n();
const query = ref("");
const results = ref<Array<{ page: number; text: string }>>([]);
const searching = ref(false);

async function doSearch() {
  const q = query.value.trim().toLowerCase();
  if (!q) { results.value = []; return; }
  searching.value = true;
  results.value = [];
  try {
    const pdf = doc.pdfDoc;
    if (!pdf) return;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      page.cleanup();
      for (const item of tc.items) {
        const str = (item as any).str || "";
        const idx = str.toLowerCase().indexOf(q);
        if (idx !== -1) {
          results.value.push({ page: p, text: str.slice(Math.max(0, idx - 20), idx + q.length + 40) });
        }
      }
    }
  } catch {
    results.value = [];
  }
  searching.value = false;
}

function jumpToResult(page: number) {
  doc.setPage(page);
}
</script>

<template>
  <div class="search-panel">
    <div class="search-input-wrapper">
      <PhMagnifyingGlass :size="14" class="search-icon" />
      <input
        v-model="query"
        type="text"
        class="search-input"
        :placeholder="t('search_placeholder')"
        @keydown.enter="doSearch"
        @keydown.escape="query = ''; results = []"
      />
    </div>

    <div class="search-results">
      <div v-if="searching" class="empty-label text-[var(--text-muted)] text-xs">
        {{ t('searching') }}
      </div>
      <div v-else-if="results.length === 0 && query" class="empty-label text-[var(--text-muted)] text-xs">
        {{ t('search_no_results') }}
      </div>
      <div v-else-if="results.length === 0 && !query" class="empty-label text-[var(--text-muted)] text-xs">
        {{ t('search_type_hint') }}
      </div>
      <div
        v-for="(r, i) in results"
        :key="i"
        class="search-result-row"
        @click="jumpToResult(r.page)"
      >
        <span class="result-page font-mono text-[11px] text-[var(--text-muted)]">
          p. {{ r.page }}
        </span>
        <span class="result-text text-xs text-[var(--text-secondary)]">
          {{ r.text.slice(0, 120) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.search-input-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.search-input-wrapper:focus-within {
  border-color: var(--accent);
}

.search-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 12px;
  color: var(--text-primary);
  font-family: "Geist", sans-serif;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.empty-label {
  text-align: center;
  padding-top: 20px;
}

.search-result-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 150ms ease;
}

.search-result-row:hover {
  background: var(--accent-muted);
}

.result-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
