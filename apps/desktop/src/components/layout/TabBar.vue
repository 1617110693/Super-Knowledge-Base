<template>
  <div class="tab-bar">
    <div class="tab-list" @dragover.prevent="onListDragOver">
      <div
        v-for="tab in tabStore.tabs"
        :key="tab.id"
        class="tab-item"
        :class="{
          active: tabStore.activeTabId === tab.id,
          dragging: draggedId === tab.id,
          'drag-over-left': dragOverId === tab.id && dragOverPos === 'left',
          'drag-over-right': dragOverId === tab.id && dragOverPos === 'right',
        }"
        role="button"
        tabindex="0"
        draggable="true"
        @click="selectTab(tab.id)"
        @keydown.enter.prevent="selectTab(tab.id)"
        @keydown.space.prevent="selectTab(tab.id)"
        @pointerdown.middle.prevent="closeTab(tab.id)"
        @dragstart="onDragStart($event, tab.id)"
        @dragover.prevent="onDragOver($event, tab.id)"
        @dragleave="onDragLeave"
        @drop.prevent="onDrop(tab.id)"
        @dragend="onDragEnd"
        :title="tab.title"
      >
        <component :is="tabIconComponent(tab.url)" :size="14" class="tab-icon" />
        <span class="tab-title">{{ tab.title }}</span>
        <button
          class="tab-close"
          @click.stop="closeTab(tab.id)"
          :title="t('tabs.close')"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1.2" />
            <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { FileText, MessageSquare, Search, Settings } from "lucide-vue-next";
import { useTabStore } from "@/stores/tabStore";
import { useI18n } from "@/i18n/index";

const { t } = useI18n();

const router = useRouter();
const tabStore = useTabStore();

function tabIconComponent(url: string) {
  if (url.startsWith("/kb") || url.startsWith("/documents")) return FileText;
  if (url.startsWith("/chat")) return MessageSquare;
  if (url.startsWith("/search") || url.includes("search")) return Search;
  if (url.startsWith("/settings")) return Settings;
  return FileText;
}

function selectTab(id: string) {
  const tab = tabStore.tabs.find((t) => t.id === id);
  if (tab) {
    tabStore.setActiveTab(id);
    router.push(tab.url);
  }
}

function closeTab(id: string) {
  tabStore.closeTab(id);
  const newActive = tabStore.tabs.find((t) => t.id === tabStore.activeTabId);
  if (newActive) {
    router.push(newActive.url);
  } else {
    router.push("/");
  }
}

// ── Drag-to-reorder ──
const draggedId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);
const dragOverPos = ref<"left" | "right">("left");

function onDragStart(e: DragEvent, id: string) {
  draggedId.value = id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }
}

function onListDragOver(e: DragEvent) {
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
}

function onDragOver(e: DragEvent, id: string) {
  if (!draggedId.value || draggedId.value === id) return;
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dragOverId.value = id;
  // Determine if cursor is on left or right half of the tab
  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  dragOverPos.value = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
}

function onDragLeave() {
  // Only clear if leaving to outside any tab (handled in dragend/drop)
}

function onDrop(targetId: string) {
  if (!draggedId.value || draggedId.value === targetId) {
    onDragEnd();
    return;
  }
  const tabs = [...tabStore.tabs];
  const fromIdx = tabs.findIndex((t) => t.id === draggedId.value);
  let toIdx = tabs.findIndex((t) => t.id === targetId);
  if (fromIdx === -1 || toIdx === -1) {
    onDragEnd();
    return;
  }
  // If dropping on right half, insert after target
  if (dragOverPos.value === "right" && toIdx < tabs.length - 1) {
    // Adjust for removal: if from < to, removing shifts toIdx by -1
  }
  const [moved] = tabs.splice(fromIdx, 1);
  // Recalculate toIdx after removal
  toIdx = tabs.findIndex((t) => t.id === targetId);
  if (dragOverPos.value === "right") toIdx++;
  tabs.splice(toIdx, 0, moved);
  tabStore.reorderTabs(tabs);
  onDragEnd();
}

function onDragEnd() {
  draggedId.value = null;
  dragOverId.value = null;
}
</script>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  height: 100%;
  gap: 2px;
  overflow: hidden;
  padding: 0 4px;
  flex: 1;
  min-width: 0;
}

.tab-list {
  display: flex;
  align-items: stretch;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(144, 147, 153, 0.2) transparent;
  position: relative;
}

.tab-list::-webkit-scrollbar {
  height: 3px;
  -webkit-appearance: none;
}

.tab-list::-webkit-scrollbar-track {
  background: transparent;
}

.tab-list::-webkit-scrollbar-thumb {
  background: rgba(144, 147, 153, 0.2);
  border-radius: 2px;
}

.tab-list::-webkit-scrollbar-thumb:hover {
  background: rgba(144, 147, 153, 0.4);
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 6px 6px 0 0;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 1;
  min-width: 44px;
  max-width: 180px;
  position: relative;
  transition: background 120ms ease, color 120ms ease;
  margin-top: 4px;
}

.tab-item:hover {
  background: var(--surface-raised);
  color: var(--text-primary);
}

.tab-item.active {
  background: var(--bg-primary);
  color: var(--text-primary);
}

.tab-item.active::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--accent-color);
  border-radius: 1px 1px 0 0;
}

/* Drag-to-reorder styles */
.tab-item.dragging {
  opacity: 0.35;
}
.tab-item.drag-over-left::before {
  content: "";
  position: absolute;
  left: -1px;
  top: 4px;
  bottom: 0;
  width: 2px;
  background: var(--accent-color);
  border-radius: 1px;
}
.tab-item.drag-over-right::after {
  content: "";
  position: absolute;
  right: -1px;
  top: 4px;
  bottom: 0;
  width: 2px;
  background: var(--accent-color);
  border-radius: 1px;
}

.tab-icon {
  flex-shrink: 0;
  opacity: 0.7;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
}

.tab-item:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: var(--surface-raised);
  color: var(--text-primary);
}
	/* ── Tab TransitionGroup animations ── */
.tab-list-enter-active,
.tab-list-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.tab-list-leave-active {
  position: absolute;
  pointer-events: none;
}
.tab-list-enter-from,
.tab-list-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}
</style>
