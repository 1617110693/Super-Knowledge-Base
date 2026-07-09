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

// ── Chat popover (collapsed mode) ──
const chatPopover = ref(false);
const chatBtnRef = ref<HTMLButtonElement | null>(null);
const popoverRef = ref<HTMLDivElement | null>(null);

// ── Python error dialog ──
const showError = ref(false);

// ── Close popover on outside click / Escape ──
function onDocumentClick(e: MouseEvent) {
  if (!chatPopover.value) return;
  const target = e.target as Node;
  if (chatBtnRef.value?.contains(target)) return;
  if (popoverRef.value?.contains(target)) return;
  chatPopover.value = false;
}
function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") chatPopover.value = false;
}

watch(chatPopover, (val) => {
  if (val) {
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
  } else {
    document.removeEventListener("mousedown", onDocumentClick);
    document.removeEventListener("keydown", onKeyDown);
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

// ── Actions ──
function newConversation() {
  const id = chatStore.newConversation();
  return id;
}

function startNewChat() {
  const id = newConversation();
  router.push(`/chat/${id}`);
  chatPopover.value = false;
}

function startNewChatExpanded() {
  chatExpanded.value = true;
  const id = newConversation();
  router.push(`/chat/${id}`);
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
      const id = newConversation();
      router.replace(`/chat/${id}`);
    }
  }
}
</script>

<template>
  <!-- ═══════ Collapsed mode ═══════ -->
  <template v-if="collapsed">
    <aside class="sidebar sidebar-collapsed">
      <!-- Top: expand button -->
      <button
        class="sb-icon-btn"
        :title="t('nav.expandSidebar')"
        @click="toggleCollapsed"
      >
        <PanelLeft :size="16" />
      </button>

      <!-- Backend status -->
      <span
        class="sb-status-dot"
        :class="settingsStore.pythonRunning ? 'bg-green' : 'bg-red'"
        :title="settingsStore.pythonRunning ? t('app.backendReady') : t('app.backendOffline')"
      />

      <div class="sb-icon-list">
        <!-- Overview -->
        <button
          class="sb-icon-btn"
          :class="{ active: isActive('/') && !kbId }"
          :title="t('nav.overview')"
          @click="router.push('/')"
        >
          <LayoutDashboard :size="16" />
        </button>

        <!-- KBs -->
        <button
          v-for="kb in sortedKBs.slice(0, 8)"
          :key="kb.id"
          class="sb-icon-btn"
          :class="{ active: kbId === kb.id }"
          :title="kb.name"
          @click="router.push(`/kb/${kb.id}`)"
        >
          <Pin v-if="kb.pinned" :size="16" class="text-amber-500" />
          <Layers v-else :size="16" />
        </button>

        <!-- Chat popover -->
        <div class="sb-popover-host">
          <button
            ref="chatBtnRef"
            class="sb-icon-btn"
            :class="{ active: route.path.startsWith('/chat') }"
            :title="t('nav.chatSection')"
            @click="chatPopover = !chatPopover"
          >
            <MessageSquare :size="16" />
          </button>
          <div
            v-if="chatPopover"
            ref="popoverRef"
            class="sb-popover"
          >
            <div class="sb-popover-header">
              <span class="sb-popover-title">{{ t("nav.chatSection") }}</span>
              <button
                class="sb-icon-btn-xs"
                :title="t('nav.newChat')"
                @click="startNewChat"
              >
                <Plus :size="14" />
              </button>
            </div>
            <div class="sb-popover-list">
              <p v-if="recentConversations.length === 0" class="sb-empty-text">
                {{ t("nav.noConversations") }}
              </p>
              <div
                v-for="conv in recentConversations"
                :key="conv.id"
                class="sb-popover-item group"
              >
                <router-link
                  :to="`/chat/${conv.id}`"
                  class="sb-popover-link"
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
                    chatPopover = false;
                  "
                >
                  <MessageSquare :size="12" class="shrink-0" />
                  <span class="truncate">
                    {{
                      conv.title ||
                      conv.messages[0]?.content?.slice(0, 40) ||
                      t("chat.new")
                    }}
                  </span>
                </router-link>
                <button
                  class="sb-popover-delete"
                  @click.prevent.stop="handleDeleteConversation(conv.id)"
                  :title="t('kb.deleteTooltip')"
                >
                  <Trash2 :size="10" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom: Settings -->
      <div class="sb-bottom">
        <button
          class="sb-icon-btn"
          :class="{ active: isActive('/settings') }"
          :title="t('nav.settings')"
          @click="router.push('/settings')"
        >
          <Settings :size="16" />
        </button>
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
    </aside>
  </template>

  <!-- ═══════ Expanded mode ═══════ -->
  <template v-else>
    <aside class="sidebar sidebar-expanded">
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
            >
              <Pin
                v-if="kb.pinned"
                :size="10"
                class="text-amber-500 shrink-0"
              />
              <Layers v-else :size="12" class="shrink-0" />
              <span class="truncate">{{ kb.name }}</span>
              <span class="sb-item-count">{{ kb.document_count }}</span>
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
              @click.stop="startNewChatExpanded"
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
    </aside>

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
  </template>
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
  align-items: center;
  padding: 8px 0;
  gap: 4px;
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
.bg-green {
  background: var(--el-color-success);
}
.bg-red {
  background: var(--el-color-danger);
}
.text-primary {
  color: var(--el-color-primary);
}
.text-amber-500 {
  color: #f59e0b;
}
.text-red-500 {
  color: var(--el-color-danger);
}

/* ── Icon list (collapsed) ── */
.sb-icon-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px;
  width: 100%;
  overflow-y: auto;
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
.sb-popover-host {
  position: relative;
}

.sb-popover {
  position: fixed;
  z-index: 100;
  width: 240px;
  max-height: 300px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
  overflow: hidden;
  left: 60px;
  top: auto;
  margin-top: -8px;
}

.sb-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
}

.sb-popover-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--el-text-color-secondary);
}

.sb-popover-list {
  max-height: 240px;
  overflow-y: auto;
}

.sb-popover-item {
  position: relative;
  display: flex;
}

.sb-popover-link {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-decoration: none;
  transition: all 120ms;
  overflow: hidden;
}
.sb-popover-link:hover {
  background: var(--el-fill-color);
}
.sb-popover-link.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 500;
}

.sb-popover-delete {
  display: none;
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-disabled);
  cursor: pointer;
}
.group:hover .sb-popover-delete {
  display: flex;
  align-items: center;
  justify-content: center;
}
.sb-popover-delete:hover {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

/* ── Expanded Header ── */
.sb-header {
  padding: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.sb-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sb-app-title {
  font-size: 14px;
  font-weight: 700;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.sb-status-text {
  font-size: 11px;
  color: var(--el-text-color-disabled);
}

.sb-error-link {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11px;
  color: #d97706;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.sb-error-link:hover {
  color: #b45309;
}

/* ── Middle section ── */
.sb-middle {
  flex: 1;
  display: grid;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
  padding: 4px;
  overflow: hidden;
  min-height: 0;
}

/* ── Sections ── */
.sb-section {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.sb-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  font-size: 13px;
  transition: all 120ms;
  flex-shrink: 0;
}
.sb-section-header:hover {
  background: var(--el-fill-color);
}

.sb-section-label {
  flex: 1;
  text-align: left;
}

.ml-auto {
  margin-left: auto;
}

.sb-section-list {
  margin-left: 8px;
  border-left: 1px solid var(--el-border-color-lighter);
  padding-left: 4px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

/* ── Items ── */
.sb-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-decoration: none;
  transition: all 120ms;
  overflow: hidden;
}
.sb-item:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}
.sb-item.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 500;
}

.sb-item-count {
  font-size: 10px;
  color: var(--el-text-color-disabled);
  margin-left: auto;
  flex-shrink: 0;
}

.sb-empty-text {
  font-size: 11px;
  color: var(--el-text-color-disabled);
  padding: 4px 8px;
  margin: 0;
}

/* ── Chat items ── */
.sb-chat-item {
  position: relative;
  display: flex;
}

.sb-chat-actions {
  display: none;
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  gap: 2px;
  align-items: center;
}
.group:hover .sb-chat-actions {
  display: flex;
}

.sb-rename-input {
  font-size: 11px;
  padding: 2px 6px;
  border: 1px solid var(--el-color-primary);
  border-radius: 4px;
  outline: none;
  flex: 1;
  background: var(--el-bg-color);
}

/* ── Footer ── */
.sb-footer {
  padding: 4px;
  border-top: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

/* ── Modal ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}

.modal-card {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
  max-width: 500px;
  width: 90%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.modal-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-error {
  font-size: 11px;
  padding: 16px;
  margin: 0;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--el-fill-color-lighter);
  flex: 1;
  max-height: 400px;
}

/* ── Utilities ── */
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shrink-0 {
  flex-shrink: 0;
}
.flex-1 {
  flex: 1;
}
.items-center {
  align-items: center;
}
.gap-1 {
  gap: 4px;
}
.px-2 {
  padding-left: 8px;
  padding-right: 8px;
}
.py-1 {
  padding-top: 4px;
  padding-bottom: 4px;
}
.mt-auto {
  margin-top: auto;
}
</style>