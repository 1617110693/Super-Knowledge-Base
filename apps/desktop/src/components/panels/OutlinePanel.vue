<script setup lang="ts">
import { computed } from "vue";
import { useDocumentStore, type OutlineItem } from "@/stores/document";
import { useI18n } from "@/composables/useI18n";

const doc = useDocumentStore();
const { t } = useI18n();

const outline = computed<OutlineItem[]>(() => doc.outline ?? []);

function jumpToPage(page: number) {
  doc.setPage(page);
}
</script>

<template>
  <div class="outline-panel">
    <div v-if="outline.length === 0" class="empty-label text-[var(--text-muted)] text-xs">
      {{ t('outline_empty') }}
    </div>
    <ul v-else class="outline-tree">
      <li
        v-for="item in outline"
        :key="item.title"
        :style="{ paddingLeft: `${item.level * 12}px` }"
        class="outline-item"
        :class="{ active: item.page === doc.currentPage }"
        @click="jumpToPage(item.page)"
      >
        {{ item.title }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.outline-panel {
  font-size: 12px;
}

.empty-label {
  text-align: center;
  padding-top: 24px;
}

.outline-tree {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.outline-item {
  padding: 6px 8px;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 150ms ease, color 150ms ease;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.outline-item:hover {
  background: var(--accent-muted);
  color: var(--text-primary);
}

.outline-item.active {
  color: var(--accent);
  background: var(--accent-muted);
  font-weight: 500;
}
</style>
