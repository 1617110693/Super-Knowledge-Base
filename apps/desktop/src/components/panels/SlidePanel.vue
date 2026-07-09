<script setup lang="ts">
import { useUiStore } from "@/stores/ui";
import OutlinePanel from "@/components/panels/OutlinePanel.vue";
import ThumbnailPanel from "@/components/panels/ThumbnailPanel.vue";
import BookmarkPanel from "@/components/panels/BookmarkPanel.vue";
import SearchPanel from "@/components/panels/SearchPanel.vue";

const ui = useUiStore();

const tabs: { id: string; label: string }[] = [
  { id: "outline", label: "目录" },
  { id: "thumbnails", label: "缩略图" },
  { id: "bookmarks", label: "书签" },
  { id: "search", label: "搜索" },
];

function isActive(tabId: string): boolean {
  return ui.activePanel === tabId;
}

function toggleTab(tabId: string) {
  ui.togglePanel(tabId as any);
}
</script>

<template>
  <aside class="slide-panel">
    <!-- Tab bar -->
    <div class="tab-bar">
      <button
        v-for="tab in tabs"
        v-show="tab.id !== 'search'"
        :key="tab.id"
        :class="['tab-btn', { active: ui.activePanel === tab.id }]"
        @click="(ui as any).togglePanel(tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Panel content -->
    <div class="panel-content">
      <OutlinePanel v-if="ui.activePanel === 'outline'" />
      <ThumbnailPanel v-else-if="ui.activePanel === 'thumbnails'" />
      <BookmarkPanel v-else-if="ui.activePanel === 'bookmarks'" />
      <SearchPanel v-else-if="ui.activePanel === 'search'" />
    </div>
  </aside>
</template>

<style scoped>
.slide-panel {
  position: absolute;
  left: var(--icon-strip-width);
  top: 0;
  bottom: 0;
  z-index: 50;
  width: var(--panel-width);
  background: var(--surface-raised);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  box-shadow: 2px 0 8px rgba(0, 0, 0, 0.06);
}

.tab-bar {
  display: flex;
  gap: 2px;
  padding: 8px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  border-radius: var(--radius);
  margin: 8px 8px 0;
}

.tab-btn {
  flex: 1;
  text-align: center;
  padding: 5px 0;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  border-radius: 4px;
  cursor: pointer;
  transition: background 150ms ease, color 150ms ease;
}

.tab-btn:hover {
  color: var(--text-secondary);
}

.tab-btn.active {
  color: var(--accent);
  background: var(--surface-elevated);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  min-height: 0;
}
</style>
