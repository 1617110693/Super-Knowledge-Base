import { create } from "zustand";

// ── Types ──────────────────────────────────────────────────────────

export interface TabHeading {
  level: number;
  text: string;
  charOffset: number;
  page?: number;
  chunkIndex?: number;
}

export type TabType = "doc" | "chat";

export interface TabEntry {
  id: string;
  type: TabType;
  kbId: string;    // for doc tabs
  docId: string;   // for doc tabs
  convId: string;  // for chat tabs
  docName: string; // display name
  isDirty: boolean;
  editContent: string | null;  // in-progress edit content
  isEditing: boolean;          // was in edit mode when tab switched
  cachedAt: number;
  lastAccessedAt: number;
  // Runtime state (saved/restored on tab switch)
  scrollTop: number;
  lastChunkIdx: number | null;
  // Content cache — inactive tabs only keep the raw string (not DOM)
  content: string | null;
  anchoredContent: string | null;
  // Map-like data stored as arrays of tuples so Zustand serialization works
  startCharEntries: [number, number][] | null;
  pageChunksEntries: [number, number[]][] | null;
  pageAnchorPositions: { page: number; startChar: number }[] | null;
  headings: TabHeading[] | null;
}

const MAX_TABS = 15;
const MAX_CLOSED = 10;
const CACHE_TTL_MS = 60_000; // 60s before background refresh

// ── Helpers ────────────────────────────────────────────────────────

// Restore localStorage persisted flag
function loadTabBarVisible(): boolean {
  try {
    const raw = localStorage.getItem("skb-tab-bar-visible");
    if (raw !== null) return raw === "true";
  } catch { /* ignore */ }
  return true; // default: visible
}

function loadPersistedTabs(): TabEntry[] {
  try {
    const raw = localStorage.getItem("skb-open-tabs");
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        return data.map((t: Partial<TabEntry>) => ({
          ...t,
          // Ensure runtime-only fields are reset
          content: null,
          anchoredContent: null,
          startCharEntries: null,
          pageChunksEntries: null,
          pageAnchorPositions: null,
          headings: null,
          editContent: null,
          isEditing: false,
          isDirty: false,
          cachedAt: 0,
          lastAccessedAt: 0,
          scrollTop: t.scrollTop ?? 0,
          lastChunkIdx: t.lastChunkIdx ?? null,
        })) as TabEntry[];
      }
    }
  } catch { /* ignore */ }
  return [];
}

function persistTabs(tabs: TabEntry[]): void {
  try {
    // Only persist metadata + scroll positions, NOT full content
    const slim = tabs.map((t) => ({
      id: t.id,
      type: t.type,
      kbId: t.kbId,
      docId: t.docId,
      convId: t.convId,
      docName: t.docName,
      scrollTop: t.scrollTop,
      lastChunkIdx: t.lastChunkIdx,
    }));
    localStorage.setItem("skb-open-tabs", JSON.stringify(slim));
  } catch { /* ignore */ }
}

// Debounced persist
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(tabs: TabEntry[]): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistTabs(tabs), 1000);
}

// ── Store ──────────────────────────────────────────────────────────

interface TabState {
  tabs: TabEntry[];
  activeTabId: string | null;
  tabBarVisible: boolean;
  closedTabs: TabEntry[];

  // Actions
  openTab: (kbId: string, docId: string, docName: string) => string;
  openChatTab: (convId: string, convTitle: string) => string;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (tabId: string) => void;
  toggleTabBar: () => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  saveTabState: (tabId: string, state: Partial<TabEntry>) => void;
  clearTabCache: (tabId: string) => void;
  nextTab: () => void;
  previousTab: () => void;
  switchToTabIndex: (index: number) => void;
  reopenLastClosed: () => void;
}

export const useTabStore = create<TabState>((set, get) => ({
  tabs: loadPersistedTabs(),
  activeTabId: null,
  tabBarVisible: loadTabBarVisible(),
  closedTabs: [],

  // ── openTab ──────────────────────────────────────────────────
  openTab(kbId: string, docId: string, docName: string): string {
    const { tabs: current } = get();
    // Deduplicate: if already open, just activate
    const existing = current.find((t) => t.type === "doc" && t.kbId === kbId && t.docId === docId);
    if (existing) {
      set({
        activeTabId: existing.id,
        tabs: current.map((t) =>
          t.id === existing.id ? { ...t, lastAccessedAt: Date.now() } : t
        ),
      });
      return existing.id;
    }

    const id = crypto.randomUUID ? crypto.randomUUID() : `${kbId}:${docId}:${Date.now()}`;
    const newTab: TabEntry = {
      id,
      type: "doc" as const,
      kbId,
      docId,
      convId: "",
      docName,
      editContent: null,
      isEditing: false,
      isDirty: false,
      cachedAt: 0,
      lastAccessedAt: Date.now(),
      scrollTop: 0,
      lastChunkIdx: null,
      content: null,
      anchoredContent: null,
      startCharEntries: null,
      pageChunksEntries: null,
      pageAnchorPositions: null,
      headings: null,
    };

    let tabs = [...current, newTab];

    // LRU eviction if over limit: evict the least-recently-accessed inactive tab
    if (tabs.length > MAX_TABS) {
      const inactiveIdx = tabs.findIndex((t) => t.id !== id);
      if (inactiveIdx !== -1) {
        // Find oldest inactive
        let oldestIdx = -1;
        let oldestTime = Infinity;
        for (let i = 0; i < tabs.length; i++) {
          if (tabs[i].id !== id && tabs[i].lastAccessedAt < oldestTime) {
            oldestTime = tabs[i].lastAccessedAt;
            oldestIdx = i;
          }
        }
        if (oldestIdx !== -1) {
          const evicted = tabs[oldestIdx];
          tabs = tabs.filter((_, i) => i !== oldestIdx);
          // Push to closed stack
          const { closedTabs: prev } = get();
          const closed = [evicted, ...prev].slice(0, MAX_CLOSED);
          set({ closedTabs: closed });
        }
      }
    }

    set({ tabs, activeTabId: id });
    schedulePersist(tabs);
    return id;
  },

  // ── openChatTab ──────────────────────────────────────────────
  openChatTab(convId: string, convTitle: string): string {
    const { tabs: current } = get();
    const existing = current.find((t) => t.type === "chat" && t.convId === convId);
    if (existing) {
      set({
        activeTabId: existing.id,
        tabs: current.map((t) =>
          t.id === existing.id ? { ...t, lastAccessedAt: Date.now() } : t
        ),
      });
      return existing.id;
    }

    const id = crypto.randomUUID ? crypto.randomUUID() : `chat:${convId}:${Date.now()}`;
    const newTab: TabEntry = {
      id,
      type: "chat" as const,
      kbId: "",
      docId: "",
      convId,
      docName: convTitle,
      editContent: null,
      isEditing: false,
      isDirty: false,
      cachedAt: 0,
      lastAccessedAt: Date.now(),
      scrollTop: 0,
      lastChunkIdx: null,
      content: null,
      anchoredContent: null,
      startCharEntries: null,
      pageChunksEntries: null,
      pageAnchorPositions: null,
      headings: null,
    };

    let tabs = [...current, newTab];

    if (tabs.length > MAX_TABS) {
      let oldestIdx = -1;
      let oldestTime = Infinity;
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].id !== id && tabs[i].lastAccessedAt < oldestTime) {
          oldestTime = tabs[i].lastAccessedAt;
          oldestIdx = i;
        }
      }
      if (oldestIdx !== -1) {
        const evicted = tabs[oldestIdx];
        tabs = tabs.filter((_, i) => i !== oldestIdx);
        const { closedTabs: prev } = get();
        set({ closedTabs: [evicted, ...prev].slice(0, MAX_CLOSED) });
      }
    }

    set({ tabs, activeTabId: id });
    schedulePersist(tabs);
    return id;
  },

  // ── closeTab ─────────────────────────────────────────────────
  closeTab(tabId: string): void {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const closed = state.tabs[idx];
    let tabs = state.tabs.filter((t) => t.id !== tabId);
    let newActive = state.activeTabId;

    if (state.activeTabId === tabId) {
      // Activate nearest tab (prefer right neighbour, then left)
      if (tabs.length === 0) {
        newActive = null;
      } else {
        const nextIdx = Math.min(idx, tabs.length - 1);
        newActive = tabs[nextIdx].id;
      }
    }

    set({
      tabs,
      activeTabId: newActive,
      closedTabs: [closed, ...state.closedTabs].slice(0, MAX_CLOSED),
    });
    schedulePersist(tabs);
  },

  // ── closeOtherTabs ───────────────────────────────────────────
  closeOtherTabs(tabId: string): void {
    const state = get();
    const keep = state.tabs.find((t) => t.id === tabId);
    if (!keep) return;
    const tabs = [keep];
    set({ tabs, activeTabId: tabId });
    schedulePersist(tabs);
  },

  // ── closeTabsToRight ─────────────────────────────────────────
  closeTabsToRight(tabId: string): void {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const tabs = state.tabs.slice(0, idx + 1);
    const newActive =
      state.activeTabId && tabs.find((t) => t.id === state.activeTabId)
        ? state.activeTabId
        : tabs[tabs.length - 1]?.id ?? null;
    set({ tabs, activeTabId: newActive });
    schedulePersist(tabs);
  },

  // ── closeAllTabs ─────────────────────────────────────────────
  closeAllTabs(): void {
    set({ tabs: [], activeTabId: null });
    schedulePersist([]);
  },

  // ── setActiveTab ─────────────────────────────────────────────
  setActiveTab(tabId: string): void {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    set({
      activeTabId: tabId,
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, lastAccessedAt: Date.now() } : t
      ),
    });
  },

  // ── toggleTabBar ─────────────────────────────────────────────
  toggleTabBar(): void {
    const next = !get().tabBarVisible;
    set({ tabBarVisible: next });
    try {
      localStorage.setItem("skb-tab-bar-visible", String(next));
    } catch { /* ignore */ }
  },

  // ── reorderTabs ──────────────────────────────────────────────
  reorderTabs(fromIndex: number, toIndex: number): void {
    const { tabs } = get();
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= tabs.length || toIndex >= tabs.length) return;
    const reordered = [...tabs];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    set({ tabs: reordered });
    schedulePersist(reordered);
  },

  // ── saveTabState ─────────────────────────────────────────────
  saveTabState(tabId: string, partial: Partial<TabEntry>): void {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...partial } : t)),
    }));
    // Don't persist on every saveTabState — the scroll debouncer
    // in DocumentPreview throttles calls; persist only on close/reorder.
    // We do schedule persist for scroll changes though.
    schedulePersist(
      get().tabs.map((t) => (t.id === tabId ? { ...t, ...partial } : t))
    );
  },

  // ── clearTabCache ────────────────────────────────────────────
  clearTabCache(tabId: string): void {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              content: null,
              anchoredContent: null,
              startCharEntries: null,
              pageChunksEntries: null,
              pageAnchorPositions: null,
              headings: null,
              cachedAt: 0,
            }
          : t
      ),
    }));
  },

  // ── Navigation helpers ───────────────────────────────────────

  nextTab(): void {
    const { tabs, activeTabId } = get();
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const nextIdx = idx < 0 ? 0 : (idx + 1) % tabs.length;
    set({
      activeTabId: tabs[nextIdx].id,
      tabs: tabs.map((t) =>
        t.id === tabs[nextIdx].id ? { ...t, lastAccessedAt: Date.now() } : t
      ),
    });
  },

  previousTab(): void {
    const { tabs, activeTabId } = get();
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const prevIdx = idx < 0 ? tabs.length - 1 : (idx - 1 + tabs.length) % tabs.length;
    set({
      activeTabId: tabs[prevIdx].id,
      tabs: tabs.map((t) =>
        t.id === tabs[prevIdx].id ? { ...t, lastAccessedAt: Date.now() } : t
      ),
    });
  },

  switchToTabIndex(index: number): void {
    const { tabs } = get();
    if (index >= 0 && index < tabs.length) {
      set({
        activeTabId: tabs[index].id,
        tabs: tabs.map((t) =>
          t.id === tabs[index].id ? { ...t, lastAccessedAt: Date.now() } : t
        ),
      });
    }
  },

  reopenLastClosed(): void {
    const { closedTabs, tabs: current } = get();
    if (closedTabs.length === 0) return;
    const [restored, ...remaining] = closedTabs;
    const tabs = [...current, { ...restored, lastAccessedAt: Date.now() }];
    set({ tabs, activeTabId: restored.id, closedTabs: remaining });
    schedulePersist(tabs);
  },
}));

// ── Utilities ───────────────────────────────────────────────────────

/** Check if a tab's cache is stale (> 60s since last fetch) */
export function isCacheStale(tab: TabEntry): boolean {
  return Date.now() - tab.cachedAt > CACHE_TTL_MS;
}

/** Rebuild a Map from the serializable tuple array */
export function entriesToMap<K extends string | number, V>(
  entries: [K, V][] | null | undefined
): Map<K, V> {
  const m = new Map<K, V>();
  if (entries) {
    for (const [k, v] of entries) {
      m.set(k, v);
    }
  }
  return m;
}

/** Serialize a Map to a tuple array for Zustand */
export function mapToEntries<K extends string | number, V>(
  m: Map<K, V> | null | undefined
): [K, V][] | null {
  if (!m || m.size === 0) return null;
  return Array.from(m.entries());
}
