import { defineStore } from "pinia";
import { ref, computed } from "vue";

export interface TabItem {
  id: string;
  title: string;
  url: string;
  icon?: string;
  scrollPosition?: number;
  chunkIndex?: number;
  editState?: Record<string, unknown>;
}

const MAX_TABS = 15;
const MAX_CLOSED = 10;

export const useTabStore = defineStore("tabs", () => {
  const tabs = ref<TabItem[]>([]);
  const activeTabId = ref<string | null>(null);
  const closedTabs = ref<TabItem[]>([]);
  const tabBarVisible = ref(true);

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null);

  function openTab(tab: TabItem) {
    // If already open, just switch to it
    const existing = tabs.value.find((t) => t.id === tab.id);
    if (existing) {
      activeTabId.value = tab.id;
      // Merge any new metadata
      Object.assign(existing, tab);
      return;
    }

    // Evict least-recently-used (first) if at capacity
    if (tabs.value.length >= MAX_TABS) {
      const evicted = tabs.value.shift()!;
      pushClosed(evicted);
      if (activeTabId.value === evicted.id) {
        activeTabId.value = tabs.value[0]?.id ?? null;
      }
    }

    tabs.value.push(tab);
    activeTabId.value = tab.id;
  }

  function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const removed = tabs.value.splice(idx, 1)[0];
    pushClosed(removed);

    if (activeTabId.value === id) {
      // Pick the nearest tab
      if (tabs.value.length === 0) {
        activeTabId.value = null;
      } else if (idx < tabs.value.length) {
        activeTabId.value = tabs.value[idx].id;
      } else {
        activeTabId.value = tabs.value[tabs.value.length - 1].id;
      }
    }
  }

  function closeOtherTabs(id: string) {
    const keep = tabs.value.find((t) => t.id === id);
    if (!keep) return;
    for (const t of tabs.value) {
      if (t.id !== id) pushClosed(t);
    }
    tabs.value = [keep];
    activeTabId.value = id;
  }

  function closeRightTabs(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx === -1 || idx === tabs.value.length - 1) return;
    const right = tabs.value.splice(idx + 1);
    for (const t of right) pushClosed(t);
  }

  function reopenClosedTab() {
    const last = closedTabs.value.pop();
    if (!last) return;
    openTab(last);
  }

  function setActiveTab(id: string) {
    activeTabId.value = id;
  }

  function reorderTabs(newOrder: TabItem[]) {
    tabs.value = newOrder;
  }

  function updateTabCache(id: string, updates: Partial<TabItem>) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) Object.assign(tab, updates);
  }

  function toggleTabBar() {
    tabBarVisible.value = !tabBarVisible.value;
  }

  function pushClosed(tab: TabItem) {
    closedTabs.value.push(tab);
    if (closedTabs.value.length > MAX_CLOSED) {
      closedTabs.value.shift();
    }
  }

  return {
    tabs, activeTabId, closedTabs, tabBarVisible, activeTab,
    openTab, closeTab, closeOtherTabs, closeRightTabs, reopenClosedTab,
    setActiveTab, reorderTabs, updateTabCache, toggleTabBar,
  };
});
