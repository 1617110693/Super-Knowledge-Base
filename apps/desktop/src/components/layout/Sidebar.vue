<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import {
  BookOpen,
  Settings,
  FolderOpen,
  Layers,
  Pin,
  MessageSquare,
  Plus,
  ChevronDown,
  ChevronRight,
  LayoutDashboard,
  Pencil,
  Check,
  Trash2,
  PanelLeftClose,
  PanelLeft,
  AlertCircle,
  X,
} from "lucide-vue-next";
import { useKBStore } from "@/stores/kbStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useChatStore } from "@/stores/chatStore";
import { useTabStore } from "@/stores/tabStore";
import { useI18n } from "@/i18n/index";
import type { KnowledgeBase } from "@/types";

const COLLAPSED_KEY = "skb-sidebar-collapsed";

const router = useRouter();
const route = useRoute();
const kbStore = useKBStore();
const settingsStore = useSettingsStore();
const chatStore = useChatStore();
const tabStore = useTabStore();
const { t } = useI18n();

const kbId = computed(() => route.params.kbId as string | undefined);

// ── Collapse state ──
const collapsed = ref(false);
try {
  collapsed.value = localStorage.getItem(COLLAPSED_KEY) === "true";
} catch {
  /* ignore */
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed.value));
  } catch {
    /* ignore */
  }
}

// ── Section expand/collapse ──
const kbExpanded = ref(true);
const chatExpanded = ref(true);

// ── Chat rename ──
const renamingId = ref<string | null>(null);
const renameDraft = ref("");

// ── Context menu ──
const ctxMenu = ref<{
  visible: boolean;
  x: number;
  y: number;
  items: { label: string; danger?: boolean; action: () => void }[];
}>({ visible: false, x: 0, y: 0, items: [] });

// ── Rename dialog ──
const renameDialog = ref<{ visible: boolean; id: string; name: string; type: "kb" | "chat" }>(
  { visible: false, id: "", name: "", type: "chat" }
);

// ── Python error dialog ──
const showError = ref(false);

// ── Close context menu on outside click / Escape ──
function closeCtxMenu() { ctxMenu.value.visible = false; }
function onCtxKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") closeCtxMenu();
}
watch(() => ctxMenu.value.visible, (val) => {
  if (val) {
    document.addEventListener("keydown", onCtxKeyDown);
  } else {
    document.removeEventListener("keydown", onCtxKeyDown);
  }
});

// ── Load ──
onMounted(() => {
  kbStore.loadKBs();
  chatStore.load();
});

// ── Computed ──
const sortedKBs = computed(() => kbStore.getSortedKBs());
const recentConversations = computed(() => chatStore.conversations);

function isActive(path: string) {
  return route.path === path || route.path.startsWith(path + "/");
}

function isChatActive() {
  const active = route.path.startsWith("/chat") && route.path.length > 6;
  console.log("[Sidebar] isChatActive:", route.path, "→", active);
  return active;
}

// ── Actions ──
function newConversation() {
  const id = chatStore.newConversation();
  return id;
}

function ensureNewChat() {
  // Reuse existing empty-title conversation if one exists
  const existing = chatStore.conversations.find(c => !c.title || c.title === "");
  if (existing) {
    chatStore.setActiveConversation(existing.id);
    router.push(`/chat/${existing.id}`);
  } else {
    const id = chatStore.newConversation();
    router.push(`/chat/${id}`);
  }
}

function commitRenameDialog() {
  const d = renameDialog.value;
  if (!d.visible || !d.name.trim()) { d.visible = false; return; }
  if (d.type === "kb") {
    kbStore.updateKB(d.id, d.name.trim(), null);
  } else {
    chatStore.renameConversation(d.id, d.name.trim());
  }
  d.visible = false;
}

function startRename(convId: string, title: string) {
  renamingId.value = convId;
  renameDraft.value = title || "";
}

function commitRename(convId: string) {
  if (renameDraft.value.trim()) {
    chatStore.renameConversation(convId, renameDraft.value.trim());
  }
  renamingId.value = null;
}

function handleDeleteConversation(convId: string) {
  chatStore.deleteConversation(convId);
  const tab = useTabStore().tabs.find((t) => t.id === convId);
  if (tab) useTabStore().closeTab(tab.id);
  if (convId === chatStore.activeConversationId || route.path === `/chat/${convId}`) {
    const remaining = chatStore.conversations.filter((c) => c.id !== convId);
    if (remaining.length > 0) {
      router.replace(`/chat/${remaining[0].id}`);
    } else {
      const id = chatStore.newConversation();
      router.replace(`/chat/${id}`);
    }
  }
}

// ── Context menu helpers ──
function showKbCtxMenu(kb: KnowledgeBase, e: MouseEvent) {
  e.preventDefault();
  ctxMenu.value = {
    visible: true, x: e.clientX, y: e.clientY,
    items: [
      {
        label: "重命名", action: () => {
          renameDialog.value = { visible: true, id: kb.id, name: kb.name, type: "kb" };
        },
      },
      {
        label: "删除", danger: true, action: () => {
          if (confirm(`确认删除知识库"${kb.name}"？`)) kbStore.deleteKB(kb.id);
        },
      },
    ],
  };
}
function showChatCtxMenu(conv: { id: string; title: string }, e: MouseEvent) {
  e.preventDefault();
  ctxMenu.value = {
    visible: true, x: e.clientX, y: e.clientY,
    items: [
      {
        label: "重命名", action: () => {
          renameDialog.value = { visible: true, id: conv.id, name: conv.title, type: "chat" };
        },
      },
      {
        label: "删除", danger: true, action: () => handleDeleteConversation(conv.id),
      },
    ],
  };
}
</script>

<template>
  <aside class="sidebar" :class="collapsed ? 'sidebar-collapsed' : 'sidebar-expanded'">
    <!-- Collapsed mode icons -->
    <div v-show="collapsed" class="sidebar-collapsed-content">
      <div class="sc-top">
        <button class="sb-icon-btn" :title="t('nav.expandSidebar')" @click="toggleCollapsed">
          <PanelLeft :size="16" />
        </button>
        <span class="sb-status-dot" :class="settingsStore.pythonRunning ? 'bg-green' : 'bg-red'"
              :title="settingsStore.pythonRunning ? t('app.backendReady') : t('app.backendOffline')" />
      </div>
      <div class="sc-middle">
        <div class="sc-top-half">
          <button class="sb-icon-btn sb-nav-btn" :class="{ active: isActive('/') && !kbId }" :title="t('nav.overview')" @click="router.push('/')">
            <LayoutDashboard :size="16" />
          </button>
          <div class="sc-kb-list">
            <button v-for="kb in sortedKBs" :key="kb.id" class="sb-icon-btn" :class="{ active: kbId === kb.id }" :title="kb.name" @click="router.push(`/kb/${kb.id}`)" @contextmenu.prevent="showKbCtxMenu(kb, $event)">
              <Pin v-if="kb.pinned" :size="16" class="text-amber-500" />
              <Layers v-else :size="16" />
            </button>
          </div>
        </div>
        <div class="sc-bottom-half">
          <button class="sb-nav-btn-chat-icon" :title="t('nav.chatSection')" @click="ensureNewChat">
            <MessageSquare :size="16" />
          </button>
          <div class="sc-recent-chats">
            <button v-for="conv in recentConversations" :key="conv.id" class="sb-icon-btn sb-icon-btn-sm" :class="{ active: chatStore.activeConversationId === conv.id && route.path.startsWith('/chat') }" :title="conv.title || conv.messages[0]?.content?.slice(0, 30) || t('chat.new')" @click="chatStore.setActiveConversation(conv.id); tabStore.openTab({ id: conv.id, title: conv.title || conv.messages[0]?.content?.slice(0, 30) || t('chat.new'), url: `/chat/${conv.id}` }); router.push(`/chat/${conv.id}`)" @contextmenu.prevent="showChatCtxMenu(conv, $event)">
              <MessageSquare :size="12" />
            </button>
          </div>
        </div>
      </div>
      <div class="sc-bottom">
        <button class="sb-icon-btn" :class="{ active: isActive('/settings') }" :title="t('nav.settings')" @click="router.push('/settings')">
          <Settings :size="16" />
        </button>
      </div>
    </div>

    <!-- ═══════ Expanded mode content ═══════ -->
    <div class="sidebar-expanded-content">
      <!-- App header -->
      <div class="sb-header">
        <div class="sb-header-row">
          <h1 class="sb-app-title">
            <BookOpen :size="16" class="text-primary" />
            {{ t("nav.superKb") }}
          </h1>
          <button
            class="sb-icon-btn-xs"
            :title="t('nav.collapseSidebar')"
            @click="toggleCollapsed"
          >
            <PanelLeftClose :size="14" />
          </button>
        </div>
        <div class="sb-status-row">
          <span
            class="sb-status-dot"
            :class="settingsStore.pythonRunning ? 'bg-green' : 'bg-red'"
          />
          <span class="sb-status-text">
            {{ settingsStore.pythonRunning ? t("app.backendReady") : t("app.backendOffline") }}
          </span>
        </div>
        <button
          v-if="settingsStore.pythonError"
          class="sb-error-link"
          @click="showError = true"
        >
          <AlertCircle :size="12" />
          {{ t("nav.viewError") }}
        </button>
      </div>

      <!-- Middle: KB + Chat sections -->
      <div class="sb-middle">
        <!-- KB Section -->
        <div class="sb-section">
          <button class="sb-section-header" @click="kbExpanded = !kbExpanded">
            <ChevronDown v-if="kbExpanded" :size="12" />
            <ChevronRight v-else :size="12" />
            <FolderOpen :size="16" />
            <span class="sb-section-label">{{ t("nav.knowledgeBases") }}</span>
          </button>
          <div v-if="kbExpanded" class="sb-section-list">
            <router-link
              to="/"
              class="sb-item"
              :class="{ active: isActive('/') && !kbId }"
            >
              <LayoutDashboard :size="12" class="shrink-0" />
              {{ t("nav.overview") }}
            </router-link>
            <router-link
              v-for="kb in sortedKBs"
              :key="kb.id"
              :to="`/kb/${kb.id}`"
              class="sb-item"
              :class="{ active: kbId === kb.id }"
              :title="kb.description || undefined"
              @contextmenu.prevent="showKbCtxMenu(kb, $event)"
            >
              <Pin
                v-if="kb.pinned"
                :size="10"
                class="shrink-0 text-amber-500"
              />
              <Layers v-else :size="10" class="shrink-0" />
              <span class="truncate">{{ kb.name }}</span>
            </router-link>
          </div>
        </div>

        <!-- Chat Section -->
        <div class="sb-section">
          <div
            class="sb-section-header"
            role="button"
            tabindex="0"
            @click="chatExpanded = !chatExpanded"
            @keydown.enter="chatExpanded = !chatExpanded"
          >
            <ChevronDown v-if="chatExpanded" :size="12" />
            <ChevronRight v-else :size="12" />
            <MessageSquare :size="16" />
            <span class="sb-section-label">{{ t("nav.chatSection") }}</span>
            <button
              class="sb-icon-btn-xs ml-auto"
              :title="t('nav.newChat')"
              @click.stop="ensureNewChat"
            >
              <Plus :size="12" />
            </button>
          </div>
          <div v-if="chatExpanded" class="sb-section-list">
            <p
              v-if="recentConversations.length === 0"
              class="sb-empty-text"
            >
              {{ t("nav.noConversations") }}
            </p>
            <div
              v-for="conv in recentConversations"
              :key="conv.id"
              class="sb-chat-item group"
              @contextmenu.prevent="showChatCtxMenu(conv, $event)"
            >
              <template v-if="renamingId === conv.id">
                <div class="flex items-center gap-1 px-2 py-1">
                  <input
                    v-model="renameDraft"
                    class="sb-rename-input"
                    autofocus
                    @keydown.enter="commitRename(conv.id)"
                    @keydown.escape="renamingId = null"
                    @blur="commitRename(conv.id)"
                  />
                </div>
              </template>
              <template v-else>
                <router-link
                  :to="`/chat/${conv.id}`"
                  class="sb-item"
                  :class="{
                    active:
                      chatStore.activeConversationId === conv.id &&
                      route.path.startsWith('/chat'),
                  }"
                  @click="
                    chatStore.setActiveConversation(conv.id);
                    tabStore.openTab({
                      id: conv.id,
                      title: conv.title || conv.messages[0]?.content?.slice(0, 30) || t('chat.new'),
                      url: `/chat/${conv.id}`,
                    });
                  "
                >
                  <MessageSquare :size="12" class="shrink-0" />
                  <span class="truncate">
                    {{
                      conv.title ||
                      conv.messages[0]?.content?.slice(0, 30) ||
                      t("chat.new")
                    }}
                  </span>
                </router-link>
                <div class="sb-chat-actions">
                  <button
                    class="sb-icon-btn-xs"
                    @click.prevent.stop="
                      startRename(conv.id, conv.title)
                    "
                    :title="t('nav.renameTooltip')"
                  >
                    <Pencil :size="10" />
                  </button>
                  <button
                    class="sb-icon-btn-xs hover:text-red-500"
                    @click.prevent.stop="handleDeleteConversation(conv.id)"
                    :title="t('kb.deleteTooltip')"
                  >
                    <Trash2 :size="10" />
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Settings footer -->
      <div class="sb-footer">
        <router-link
          to="/settings"
          class="sb-item"
          :class="{ active: isActive('/settings') }"
        >
          <Settings :size="16" />
          {{ t("nav.settings") }}
        </router-link>
      </div>
    </div>

    <!-- Error dialog -->
    <Teleport to="body">
      <div
        v-if="showError && settingsStore.pythonError"
        class="modal-overlay"
        @click="showError = false"
      >
        <div class="modal-card" @click.stop>
          <div class="modal-header">
            <h3 class="modal-title">
              <AlertCircle :size="20" class="text-red-500" />
              {{ t("app.backendError") }}
            </h3>
            <button class="sb-icon-btn-xs" @click="showError = false">
              <X :size="16" />
            </button>
          </div>
          <pre class="modal-error">{{ settingsStore.pythonError }}</pre>
        </div>
      </div>
    </Teleport>

    <!-- Rename dialog -->
    <Teleport to="body">
      <div v-if="renameDialog.visible" class="modal-overlay" @click="renameDialog.visible = false">
        <div class="modal-card" style="max-width:360px" @click.stop>
          <div class="modal-header">
            <h3 class="modal-title">{{ renameDialog.type === 'kb' ? '重命名知识库' : '重命名对话' }}</h3>
            <button class="sb-icon-btn-xs" @click="renameDialog.visible = false"><X :size="16" /></button>
          </div>
          <div class="modal-body" style="padding: 12px 16px">
            <input
              v-model="renameDialog.name"
              class="sb-rename-input"
              style="width:100%;font-size:13px;padding:6px 10px"
              autofocus
              @keydown.enter="commitRenameDialog"
              @keydown.escape="renameDialog.visible = false"
            />
          </div>
          <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:8px 16px 12px">
            <button class="sb-icon-btn-xs" style="padding:4px 12px;width:auto" @click="renameDialog.visible = false">取消</button>
            <button class="sb-icon-btn-xs" style="padding:4px 12px;width:auto;background:var(--el-color-primary);color:#fff" @click="commitRenameDialog">确定</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Context menu -->
    <Teleport to="body">
      <div v-if="ctxMenu.visible" class="ctx-overlay" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
      <div v-if="ctxMenu.visible" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }">
        <button
          v-for="item in ctxMenu.items"
          :key="item.label"
          :class="{ danger: item.danger }"
          @click="item.action(); closeCtxMenu()"
        >
          {{ item.label }}
        </button>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
/* ── Base Sidebar ── */
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
  overflow: hidden;
  height: 100%;
  transition: width 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

.sidebar-collapsed {
  width: 52px;
  padding: 0;
  gap: 0;
  overflow: hidden;
}

.sidebar-expanded {
  width: 240px;
}

/* ── Icon buttons ── */
.sb-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  transition: all 120ms;
}
.sb-icon-btn:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}
.sb-icon-btn.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
/* Nav buttons (overview, chat section) */
.sb-nav-btn {
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-regular);
  font-weight: 500;
}
.sb-nav-btn:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}
/* Overview gets blue active shade */
.sb-nav-btn.active {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}
/* Chat nav button: standalone, never gets active shade */
.sb-nav-btn-chat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-regular);
  font-weight: 500;
  cursor: pointer;
  transition: all 120ms;
}
.sb-nav-btn-chat-icon:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}

.sb-icon-btn-xs {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  transition: all 120ms;
}
.sb-icon-btn-xs:hover {
  background: var(--el-fill-color);
}

/* ── Status dot ── */
.sb-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.bg-green { background: var(--el-color-success); }
.bg-red { background: var(--el-color-danger); }
.text-primary { color: var(--el-color-primary); }
.text-amber-500 { color: #f59e0b; }
.text-red-500 { color: var(--el-color-danger); }

/* ── Icon list (collapsed) ── */
.sb-icon-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px;
  width: 100%;
  min-height: 0;
  overflow-y: auto;
}

.sb-bottom-icon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 4px;
  margin-top: auto;
  flex-shrink: 0;
}

.sb-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 4px;
}

/* ── Popover (collapsed) ── */
.sb-popover-host { position: relative; }

/* ── Context menu ── */
.ctx-overlay { position: fixed; inset: 0; z-index: 999; }
.ctx-menu {
  position: fixed; z-index: 1000; min-width: 130px;
  background: var(--el-bg-color); border: 1px solid var(--el-border-color);
  border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.12);
  padding: 4px; display: flex; flex-direction: column; gap: 1px;
}
.ctx-menu button {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border: none; border-radius: 6px;
  background: transparent; color: var(--el-text-color-regular);
  font-size: 12px; cursor: pointer; text-align: left; white-space: nowrap;
}
.ctx-menu button:hover { background: var(--el-color-primary-light-9); }
.ctx-menu button.danger { color: var(--el-color-danger); }
.ctx-menu button.danger:hover { background: rgba(220,38,38,.08); }
.sb-popover {
  position: fixed; z-index: 100; width: 280px;
  background: var(--surface); border: 1px solid var(--border-color);
  border-radius: 14px; box-shadow: 0 8px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06);
  overflow: visible;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
.popover-enter-active {
  transition: opacity 150ms ease, transform 150ms cubic-bezier(0.22, 0.61, 0.36, 1);
}
.popover-leave-active {
  transition: opacity 100ms ease, transform 100ms ease;
}
.popover-enter-from {
  opacity: 0;
  transform: scale(0.92) translateY(4px);
}
.popover-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(2px);
}
.sb-popover::before {
  content: ''; position: absolute; left: -5px; top: 14px;
  width: 10px; height: 10px; background: var(--surface);
  border-left: 1px solid var(--border-color);
  border-bottom: 1px solid var(--border-color);
  transform: rotate(45deg);
}
.sb-popover-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--border-color);
}
.sb-popover-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--text-secondary); }
.sb-popover-list { max-height: 280px; overflow-y: auto; }
.sb-popover-item { position: relative; display: flex; }
.sb-popover-link {
  flex: 1; display: flex; align-items: center; gap: 6px;
  padding: 7px 14px; font-size: 13px; color: var(--text-primary);
  text-decoration: none; transition: background 120ms; overflow: hidden;
}
.sb-popover-link:hover { background: var(--accent-muted); }
.sb-popover-link.active { background: var(--accent-muted); color: var(--accent-color); font-weight: 500; }
.sb-popover-delete {
  display: none; position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  width: 22px; height: 22px; border: none; border-radius: 6px;
  background: transparent; color: var(--text-secondary); cursor: pointer; opacity: 0.4;
}
.group:hover .sb-popover-delete { display: flex; align-items: center; justify-content: center; }
.sb-popover-delete:hover { background: rgba(220, 38, 38, 0.1); color: #dc2626; opacity: 1; }

/* ── Expanded Header ── */
.sb-header { padding: 12px; border-bottom: 1px solid var(--el-border-color-lighter); flex-shrink: 0; }
.sb-header-row { display: flex; align-items: center; justify-content: space-between; }
.sb-app-title { font-size: 14px; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 6px; }
.sb-status-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.sb-status-text { font-size: 11px; color: var(--el-text-color-disabled); }
.sb-error-link { display: flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 11px; color: #d97706; background: none; border: none; cursor: pointer; padding: 0; }
.sb-error-link:hover { color: #b45309; }

/* ── Collapsed wrappers ── */
.sidebar-collapsed-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 52px;
  overflow: hidden;
}
.sc-top {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0 4px;
  flex-shrink: 0;
}
.sc-middle {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.sc-top-half {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 0;
  padding: 4px 0;
  gap: 2px;
  overflow: hidden;
  --sb-thumb: transparent;
  --sb-thumb-hover: transparent;
}
.sc-top-half:hover {
  --sb-thumb: rgba(144, 147, 153, 0.25);
  --sb-thumb-hover: rgba(144, 147, 153, 0.45);
}
/* Keep "overview" and "new chat" buttons fixed — never shrink */
.sc-top-half > .sb-nav-btn,
.sc-bottom-half > .sb-nav-btn-chat-icon {
  flex-shrink: 0;
}
.sc-kb-list {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  flex: 1 1 0;
  padding-left: 8px;
  padding-right: 4px;
}
/* CRITICAL: prevent list items from shrinking — force scroll instead */
.sc-kb-list > button,
.sc-recent-chats > button {
  flex-shrink: 0;
}
.sc-icons {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 4px 0;
}
.sc-bottom-half {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 0;
  padding: 2px 0 4px;
  gap: 4px;
  overflow: hidden;
  --sb-thumb: transparent;
  --sb-thumb-hover: transparent;
}
.sc-bottom-half:hover {
  --sb-thumb: rgba(144, 147, 153, 0.25);
  --sb-thumb-hover: rgba(144, 147, 153, 0.45);
}
.sc-recent-chats {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  flex: 1 1 0;
  padding-left: 8px;
  padding-right: 4px;
}
/* Scrollbar for collapsed sidebar — shown on hover only */
.sc-kb-list,
.sc-recent-chats {
  scrollbar-width: thin;
  scrollbar-color: var(--sb-thumb) transparent;
}
.sc-kb-list::-webkit-scrollbar,
.sc-recent-chats::-webkit-scrollbar {
  width: 4px;
  -webkit-appearance: none;
}
.sc-kb-list::-webkit-scrollbar-track,
.sc-recent-chats::-webkit-scrollbar-track {
  background: transparent;
}
.sc-kb-list::-webkit-scrollbar-thumb,
.sc-recent-chats::-webkit-scrollbar-thumb {
  background: var(--sb-thumb);
  border-radius: 2px;
}
.sc-kb-list::-webkit-scrollbar-thumb:hover,
.sc-recent-chats::-webkit-scrollbar-thumb:hover {
  background: var(--sb-thumb-hover);
}
.sc-chat-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  padding: 2px 0 4px;
  gap: 4px;
}
.sc-chat-cell .sb-popover-host {
  flex-shrink: 0;
  line-height: 0;
}

.sb-icon-btn-sm {
  width: 30px;
  height: 30px;
  border-radius: 6px;
}
.sc-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px;
  flex-shrink: 0;
}
.sidebar-expanded-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  transition: opacity 120ms ease 130ms;
}
.sidebar-collapsed .sidebar-expanded-content {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}

/* ── Middle section ── */
.sb-middle { flex: 1; display: grid; grid-template-rows: 1fr 1fr; gap: 2px; padding: 4px; overflow: hidden; min-height: 0; }

/* ── Sections ── */
.sb-section {
  display: flex; flex-direction: column; overflow: hidden; min-height: 0;
  --sb-thumb: transparent;
  --sb-thumb-hover: transparent;
}
.sb-section:hover {
  --sb-thumb: rgba(144, 147, 153, 0.25);
  --sb-thumb-hover: rgba(144, 147, 153, 0.45);
}
.sb-section-header {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border: none; border-radius: 6px; background: transparent;
  color: var(--el-text-color-secondary); cursor: pointer; font-size: 13px; transition: all 120ms; flex-shrink: 0;
}
.sb-section-header:hover { background: var(--el-fill-color); }
.sb-section-label { flex: 1; text-align: left; }
.ml-auto { margin-left: auto; }
.sb-section-list {
  margin-left: 8px; border-left: 1px solid var(--el-border-color-lighter);
  padding-left: 4px; overflow-y: auto; overflow-x: hidden; flex: 1; min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--sb-thumb) transparent;
}
.sb-section-list::-webkit-scrollbar { width: 4px; -webkit-appearance: none; }
.sb-section-list::-webkit-scrollbar-track { background: transparent; }
.sb-section-list::-webkit-scrollbar-thumb { background: var(--sb-thumb); border-radius: 2px; }
.sb-section-list::-webkit-scrollbar-thumb:hover { background: var(--sb-thumb-hover); }

/* ── Items ── */
.sb-item {
  display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 6px;
  font-size: 12px; color: var(--el-text-color-secondary);
  text-decoration: none; transition: all 120ms; overflow: hidden;
}
.sb-item:hover { background: var(--el-fill-color); color: var(--el-text-color-primary); }
.sb-item.active { background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-weight: 500; }
.sb-item-count { font-size: 10px; color: var(--el-text-color-disabled); margin-left: auto; flex-shrink: 0; }
.sb-empty-text { font-size: 11px; color: var(--el-text-color-disabled); padding: 4px 8px; margin: 0; }

/* ── Chat items ── */
.sb-chat-item { position: relative; display: flex; }
.sb-chat-actions { display: none; position: absolute; right: 4px; top: 50%; transform: translateY(-50%); gap: 2px; align-items: center; }
.group:hover .sb-chat-actions { display: flex; }
.sb-rename-input { font-size: 11px; padding: 2px 6px; border: 1px solid var(--el-color-primary); border-radius: 4px; outline: none; flex: 1; background: var(--el-bg-color); }

/* ── Footer ── */
.sb-footer { padding: 4px; border-top: 1px solid var(--el-border-color-lighter); flex-shrink: 0; }

/* ── Modal ── */
.modal-overlay { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); }
.modal-card { background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.18); max-width: 500px; width: 90%; max-height: 80vh; display: flex; flex-direction: column; }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
.modal-title { font-size: 15px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
.modal-error { font-size: 11px; padding: 16px; margin: 0; overflow-y: auto; white-space: pre-wrap; word-break: break-all; background: var(--el-fill-color-lighter); flex: 1; max-height: 400px; }

/* ── Utilities ── */
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shrink-0 { flex-shrink: 0; }
.flex-1 { flex: 1; }
.items-center { align-items: center; }
.gap-1 { gap: 4px; }
.px-2 { padding-left: 8px; padding-right: 8px; }
.py-1 { padding-top: 4px; padding-bottom: 4px; }
.mt-auto { margin-top: auto; }
</style>