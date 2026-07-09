<script setup lang="ts">
import { ref, computed, onMounted, inject } from "vue";
import { useRouter } from "vue-router";
import { Database, Plus, Pin, PinOff, SortAsc, SortDesc, Search, Calendar } from "lucide-vue-next";
import { useKBStore, type ViewMode, type SortMode } from "@/stores/kbStore";
import { useI18n } from "@/i18n/index";

const router = useRouter();
const store = useKBStore();
const { t } = useI18n();

const showCreateDialog = ref(false);
const createName = ref("");
const createDesc = ref("");
const createLoading = ref(false);
const createError = ref("");

const openGlobalSearch = inject<() => void>("openGlobalSearch", () => {});

const sortedKBs = computed(() => store.getSortedKBs());

const sortOptions: { value: SortMode; labelKey: string }[] = [
  { value: "manual", labelKey: "kb.sortManual" },
  { value: "name-asc", labelKey: "kb.sortNameAsc" },
  { value: "name-desc", labelKey: "kb.sortNameDesc" },
  { value: "date-asc", labelKey: "kb.sortDateAsc" },
  { value: "date-desc", labelKey: "kb.sortDateDesc" },
];

const viewOptions: { value: ViewMode; label: string }[] = [
  { value: "card", label: "Card" },
  { value: "grid", label: "Grid" },
  { value: "compact", label: "Compact" },
];

onMounted(() => {
  store.loadKBs();
});

async function handleCreateKB() {
  if (!createName.value.trim()) {
    createError.value = t("kb.nameRequired");
    return;
  }
  createLoading.value = true;
  createError.value = "";
  try {
    await store.createKB(createName.value.trim(), createDesc.value.trim());
    showCreateDialog.value = false;
    createName.value = "";
    createDesc.value = "";
  } catch (e) {
    createError.value = String(e);
  } finally {
    createLoading.value = false;
  }
}

function openKB(kbId: string) {
  router.push({ name: "kb-settings", params: { kbId } });
}

function togglePin(kbId: string) {
  store.togglePinKB(kbId);
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}
</script>

<template>
  <div class="kb-dashboard">
    <!-- Header -->
    <div class="dashboard-header">
      <div class="header-left">
        <Database :size="22" class="header-icon" />
        <h1 class="dashboard-title">{{ t("kb.dashboard") }}</h1>
      </div>
      <div class="header-actions">
        <div class="view-select">
          <el-select
            v-model="store.viewMode"
            size="small"
            style="width: 110px"
            :teleported="false"
            @change="(v: any) => store.setViewMode(v as ViewMode)"
          >
            <el-option
              v-for="opt in viewOptions"
              :key="opt.value"
              :label="t('kb.view' + opt.value.charAt(0).toUpperCase() + opt.value.slice(1))"
              :value="opt.value"
            />
          </el-select>
        </div>
        <div class="sort-select">
          <SortAsc v-if="store.sortMode === 'name-asc' || store.sortMode === 'date-asc'" :size="14" />
          <SortDesc v-else :size="14" />
          <el-select
            v-model="store.sortMode"
            size="small"
            :teleported="false"
            :placeholder="t('kb.sortPlaceholder')"
            @change="(v: any) => store.setSortMode(v as SortMode)"
          >
            <el-option
              v-for="opt in sortOptions"
              :key="opt.value"
              :label="t(opt.labelKey)"
              :value="opt.value"
            />
          </el-select>
        </div>
        <el-button size="small" @click="openGlobalSearch">
          <Search :size="14" style="margin-right: 4px" />
          {{ t("search.searchAllBtn") }}
        </el-button>
        <el-button size="small" @click="showCreateDialog = true">
          <Plus :size="14" style="margin-right: 4px" />
          {{ t("kb.newBtn") }}
        </el-button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="store.loading && sortedKBs.length === 0" class="loading-state">
      <div class="loading-spinner" />
      <p>{{ t("kb.loading") }}</p>
    </div>

    <!-- Error -->
    <div v-else-if="store.error && sortedKBs.length === 0" class="error-state">
      <p class="error-text">{{ store.error }}</p>
      <el-button size="small" @click="store.loadKBs()">{{ t("kb.retry") }}</el-button>
    </div>

    <!-- Empty -->
    <div v-else-if="sortedKBs.length === 0" class="empty-state">
      <Database :size="48" class="empty-icon" />
      <p class="empty-title">{{ t("kb.empty") }}</p>
      <p class="empty-hint">{{ t("kb.emptyHintCreate") }}</p>
      <el-button type="primary" @click="showCreateDialog = true">
        <Plus :size="14" style="margin-right: 4px" />
        {{ t("kb.newBtn") }}
      </el-button>
    </div>

    <!-- KB Grid -->
    <div v-else class="kb-grid" :class="`view-${store.viewMode}`">
      <div
        v-for="kb in sortedKBs"
        :key="kb.id"
        class="kb-card"
        @click="openKB(kb.id)"
      >
        <div class="kb-card-header">
          <div class="kb-card-title-row">
            <Database :size="18" class="kb-card-icon" />
            <span class="kb-card-name">{{ kb.name }}</span>
          </div>
          <button
            class="pin-btn"
            :class="{ pinned: kb.pinned }"
            :title="kb.pinned ? t('kb.unpin') : t('kb.pin')"
            @click.stop="togglePin(kb.id)"
          >
            <Pin v-if="kb.pinned" :size="14" />
            <PinOff v-else :size="14" />
          </button>
        </div>
        <p v-if="kb.description" class="kb-card-desc">{{ kb.description }}</p>
        <div class="kb-card-stats">
          <span class="stat-item">
            <span class="stat-value">{{ kb.document_count }}</span>
            <span class="stat-label">{{ t("kb.statDocs") }}</span>
          </span>
          <span class="stat-item">
            <span class="stat-value">{{ kb.chunk_count }}</span>
            <span class="stat-label">{{ t("kb.statChunks") }}</span>
          </span>
        </div>
        <div class="kb-card-footer">
          <Calendar :size="12" />
          <span>{{ formatDate(kb.created_at) }}</span>
        </div>
      </div>
    </div>

    <!-- Create Dialog -->
    <el-dialog
      v-model="showCreateDialog"
      :title="t('kb.createDialogTitle')"
      width="420px"
      :close-on-click-modal="false"
      :teleported="false"
    >
      <el-form @submit.prevent="handleCreateKB">
        <el-form-item :label="t('kb.name')" required :error="createError">
          <el-input
            v-model="createName"
            :placeholder="t('kb.namePlaceholder')"
            @keyup.enter="handleCreateKB"
          />
        </el-form-item>
        <el-form-item :label="t('kb.description')">
          <el-input
            v-model="createDesc"
            type="textarea"
            :rows="3"
            :placeholder="t('kb.descPlaceholder')"
          />
        </el-form-item>
        <el-form-item>
          <div class="dialog-actions">
            <el-button @click="showCreateDialog = false">{{ t("kb.cancel") }}</el-button>
            <el-button type="primary" :loading="createLoading" @click="handleCreateKB">
              {{ t("kb.createBtn") }}
            </el-button>
          </div>
        </el-form-item>
      </el-form>
    </el-dialog>
  </div>
</template>

<style scoped>
.kb-dashboard {
  padding: 24px;
  height: 100%;
  overflow-y: auto;
}

.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-icon {
  color: var(--accent-color);
}

.dashboard-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.view-select { display: flex; align-items: center; gap: 4px; }
.view-select :deep(.el-select) { min-width: 100px; }
.sort-select { display: flex; align-items: center; gap: 4px; color: var(--text-secondary); }
.sort-select :deep(.el-select) { min-width: 110px; }

/* Style select dropdowns to match app theme */
:deep(.el-select-dropdown) {
  border-radius: 10px;
  border: 1px solid var(--border-color);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  background: var(--surface);
}
:deep(.el-select-dropdown__item) {
  border-radius: 6px;
  margin: 2px 4px;
  padding: 4px 8px;
  font-size: 13px;
}
:deep(.el-select-dropdown__item.is-selected) {
  font-weight: 600;
  color: var(--accent-color);
  background: var(--accent-muted);
}
:deep(.el-popper) {
  border: 1px solid var(--border-color) !important;
  background: var(--surface) !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08) !important;
}
:deep(.el-popper .el-scrollbar) {
  background: var(--surface);
}
:deep(.el-select-dropdown__list) {
  background: var(--surface);
  padding: 4px;
}
:deep(.el-select__wrapper) {
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 0 0 1px var(--border-color) inset;
  min-height: 28px;
  padding: 0 8px;
}
:deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--accent-color) inset;
}
:deep(.el-button--small) {
  border-radius: 8px;
  border: 1px solid var(--border-color);
  font-size: 13px;
  background: var(--surface);
  color: var(--text-primary);
}
:deep(.el-button--small:hover) {
  border-color: var(--accent-color);
  color: var(--accent-color);
}

.kb-grid { display: grid; gap: 16px; }
.kb-grid.view-card { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.kb-grid.view-grid { grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
.kb-grid.view-compact { grid-template-columns: 1fr; }

.kb-card {
  background: var(--surface);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 16px;
  cursor: pointer;
  transition: all 150ms ease;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.kb-card:hover {
  border-color: var(--accent-color);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}

.kb-card-header { display: flex; align-items: center; justify-content: space-between; }
.kb-card-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kb-card-icon { color: var(--accent-color); flex-shrink: 0; }
.kb-card-name { font-weight: 600; font-size: 15px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.pin-btn {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: transparent; color: var(--text-secondary); cursor: pointer; flex-shrink: 0;
  transition: all 150ms ease;
}
.pin-btn:hover { background: var(--accent-muted); color: var(--accent-color); }
.pin-btn.pinned { color: var(--accent-color); }

.kb-card-desc { font-size: 13px; color: var(--text-secondary); margin: 0; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.kb-card-stats { display: flex; gap: 16px; }
.stat-item { display: flex; align-items: baseline; gap: 4px; }
.stat-value { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.stat-label { font-size: 12px; color: var(--text-secondary); }
.kb-card-footer { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); padding-top: 8px; border-top: 1px solid var(--border-color); }

.loading-state, .error-state, .empty-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 80px 24px; text-align: center; gap: 12px;
}
.loading-spinner { width: 24px; height: 24px; border: 2px solid var(--border-color); border-top-color: var(--accent-color); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.empty-icon { color: var(--border-color); }
.empty-title { font-size: 16px; font-weight: 500; color: var(--text-primary); margin: 0; }
.empty-hint { font-size: 13px; color: var(--text-secondary); margin: 0; }
.error-text { font-size: 13px; color: var(--destructive); margin: 0; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; width: 100%; }
</style>
