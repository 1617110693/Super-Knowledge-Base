<template>
  <div v-show="tabStore.tabBarVisible" class="tab-bar">
    <div class="tab-list" ref="tabListRef">
      <div
        v-for="tab in tabStore.tabs"
        :key="tab.id"
        class="tab-item"
        :class="{ active: tabStore.activeTabId === tab.id }"
        role="button"
        tabindex="0"
        @click="selectTab(tab.id)"
        @keydown.enter.prevent="selectTab(tab.id)"
        @keydown.space.prevent="selectTab(tab.id)"
        @pointerdown.middle.prevent="closeTab(tab.id)"
        :title="tab.title"
      >
        <component :is="tabIconComponent(tab.url)" :size="14" class="tab-icon" />
        <span class="tab-title">{{ tab.title }}</span>
        <button
          class="tab-close"
          @click.stop="closeTab(tab.id)"
          :title="'Close'"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1.2" />
            <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </div>
    </div>

    <button class="tab-new-btn" title="New Chat" @click="newChat">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="1.5" />
        <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { FileText, MessageSquare, Search, Settings } from "lucide-vue-next";
import { useTabStore } from "@/stores/tabStore";
import { useChatStore } from "@/stores/chatStore";

const router = useRouter();
const tabStore = useTabStore();
const chatStore = useChatStore();
const tabListRef = ref<HTMLElement | null>(null);

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
}

function newChat() {
  const id = chatStore.newConversation();
  tabStore.openTab({ id: `chat-${id}`, title: "New Chat", url: `/chat/${id}` });
  router.push(`/chat/${id}`);
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
  max-width: 680px;
}

.tab-list {
  display: flex;
  align-items: stretch;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.tab-list::-webkit-scrollbar {
  display: none;
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
  flex-shrink: 0;
  min-width: 0;
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

.tab-new-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 6px;
  flex-shrink: 0;
  margin-top: 4px;
  transition: background 120ms ease, color 120ms ease;
}

.tab-new-btn:hover {
  background: var(--surface-raised);
  color: var(--text-primary);
}
</style>
