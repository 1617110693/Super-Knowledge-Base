<script setup lang="ts">
import { computed } from "vue";
import { useAnnotationStore } from "@/stores/annotations";
import { useDocumentStore } from "@/stores/document";
import { PhX } from "@phosphor-icons/vue";
import { useI18n } from "@/composables/useI18n";

const ann = useAnnotationStore();
const doc = useDocumentStore();
const { t } = useI18n();

const bookmarks = computed(() => ann.store.bookmarks ?? []);

function jumpToPage(page: number) {
  doc.setPage(page);
}

async function removeBookmark(id: string) {
  ann.removeAnnotation(id);
}
</script>

<template>
  <div class="bookmark-panel">
    <div v-if="bookmarks.length === 0" class="empty-label text-[var(--text-muted)] text-xs">
      {{ t('bookmarks_empty') }}<span class="block text-[11px] mt-1">{{ t('bookmarks_hint') }}</span>
    </div>
    <ul v-else class="bookmark-list">
      <li
        v-for="b in bookmarks"
        :key="b.id"
        class="bookmark-row"
        @click="jumpToPage(b.page)"
      >
        <span class="bookmark-label">{{ b.label }}</span>
        <span class="bookmark-meta">p. {{ b.page }}</span>
        <button
          class="remove-btn"
          :title="t('remove_bookmark')"
          @click.stop="removeBookmark(b.id)"
        >
          <PhX :size="12" />
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.bookmark-panel {
  font-size: 12px;
}

.empty-label {
  text-align: center;
  padding-top: 24px;
}

.bookmark-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bookmark-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 150ms ease;
}

.bookmark-row:hover {
  background: var(--accent-muted);
}

.bookmark-label {
  flex: 1;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bookmark-meta {
  font-family: "Geist Mono", monospace;
  font-size: 11px;
  color: var(--text-muted);
}

.remove-btn {
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 3px;
  display: flex;
  opacity: 0;
  transition: opacity 150ms ease, color 150ms ease;
}

.bookmark-row:hover .remove-btn {
  opacity: 1;
}

.remove-btn:hover {
  color: var(--text-primary);
}
</style>
