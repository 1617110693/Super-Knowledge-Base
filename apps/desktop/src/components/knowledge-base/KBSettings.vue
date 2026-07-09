<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ArrowLeft,
  FileText,
  Layers,
  Upload,
  Trash2,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  FolderOpen,
  Search,
  Database,
  Pencil,
  RefreshCw,
  Check,
  FolderSearch,
  Copy,
  X,
  Plus,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  GripHorizontal,
} from "lucide-vue-next";
import { useKBStore } from "@/stores/kbStore";
import { useTabStore } from "@/stores/tabStore";
import { useI18n } from "@/i18n/index";
import type { Document } from "@/types";
import { ElMessage, ElMessageBox } from "element-plus";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import ErrorDialog from "@/components/common/ErrorDialog.vue";
import MoveCopyDialog from "@/components/knowledge-base/MoveCopyDialog.vue";

const route = useRoute();
const router = useRouter();
const store = useKBStore();
const tabStore = useTabStore();
const { t } = useI18n();

const kbId = computed(() => route.params.kbId as string);
const kb = computed(() => store.knowledgeBases.find((k) => k.id === kbId.value) ?? null);

// ── State ──
const loadingDocs = ref(true);
const dragOver = ref(false);
const uploadingRef = ref(false);

// ── KB name/desc editing ──
const editingName = ref(false);
const nameDraft = ref("");
const editingDesc = ref(false);
const descDraft = ref("");
const showDescDialog = ref(false);

// ── Delete confirmation ──
const deleteTarget = ref<{ docId: string; docName: string } | null>(null);
const deleteKBTarget = ref(false);
const deletePathTarget = ref<string | null>(null);
const disbandOnly = ref(false);

// ── Document rename ──
const renamingDocId = ref<string | null>(null);
const renameDraft = ref("");

// ── Paths (folders) ──
const paths = ref<string[]>([]);
const kbPaths = ref<Record<string, string | null>>({});
const selectedPath = computed(() => (kbId.value ? (kbPaths.value[kbId.value] ?? null) : null));
function setSelectedPath(p: string | null) {
  if (kbId.value) {
    kbPaths.value = { ...kbPaths.value, [kbId.value]: p };
  }
}

// ── New folder ──
const showNewFolder = ref(false);
const newFolderParent = ref<string | null>(null);
const newFolderName = ref("");

async function copyErrorDetail() {
  if (errorDetailTarget.value) {
    try {
      await navigator.clipboard.writeText(errorDetailTarget.value);
      errorCopied.value = true;
      setTimeout(() => { errorCopied.value = false; }, 2000);
    } catch {
      /* ignore */
    }
  }
}
const moveCopyVisible = ref(false);
const moveCopyDocId = ref("");
const moveCopyDocName = ref("");
const moveCopyAction = ref<"move" | "copy">("copy");

function openMoveCopy(doc: Document) {
  moveCopyDocId.value = doc.id;
  moveCopyDocName.value = doc.name;
  moveCopyAction.value = "copy";
  moveCopyVisible.value = true;
}
function onMoveCopyDone() {
  moveCopyVisible.value = false;
  if (kbId.value) {
    store.loadDocuments(kbId.value).then(() => loadPaths());
  }
}

// ── Expanded parent docs ──
const expandedDocs = ref<Set<string>>(new Set());

// ── Error dialog ──
const uploadError = ref("");
const errorDetailTarget = ref<string | null>(null);
const errorCopied = ref(false);

// ── Parse progress polling ──
const parseProgress = ref<Record<string, { percent: number; stage: string }>>({});
let parseTimer: ReturnType<typeof setInterval> | null = null;

// ── Flatten documents ──
function flatDocsList(docs: Document[]): Document[] {
  return docs.flatMap((d) => [d, ...(d.parts ? flatDocsList(d.parts) : [])]);
}
const allDocs = computed(() => flatDocsList(store.documents));

// ── Load ──
onMounted(async () => {
  await store.loadKBs();
  if (kbId.value) {
    loadingDocs.value = true;
    await store.loadDocuments(kbId.value);
    loadingDocs.value = false;
    loadPaths();
    startParsePolling();
  }
});

onUnmounted(() => {
  if (parseTimer) clearInterval(parseTimer);
});

// Watch for KB ID changes in the URL and reload documents
watch(
  () => route.params.kbId,
  async (newId) => {
    if (newId && typeof newId === "string") {
      loadingDocs.value = true;
      await store.loadKBs();
      await store.loadDocuments(newId);
      loadingDocs.value = false;
      loadPaths();
      startParsePolling();
    }
  }
);

watch(
  () => store.documents,
  () => {
    if (kbId.value) loadPaths();
  },
  { deep: true }
);

async function loadPaths() {
  if (!kbId.value) return;
  try {
    const { listPaths } = await import("@/services/tauriBridge");
    paths.value = await listPaths(kbId.value);
  } catch {
    /* ignore */
  }
}

function startParsePolling() {
  if (parseTimer) return;
  parseTimer = setInterval(async () => {
    if (!kbId.value) return;
    const currentDocs = store.documents;
    const flat = flatDocsList(currentDocs);
    for (const doc of flat) {
      if (doc.parse_status === "parsing") {
        store.refreshDocument(kbId.value, doc.id);
        try {
          const { getParseProgress } = await import("@/services/tauriBridge");
          const p = await getParseProgress(kbId.value, doc.id);
          if (p) parseProgress.value = { ...parseProgress.value, [doc.id]: p };
        } catch {
          /* ignore */
        }
      }
    }
  }, 3000);
}

// ── KB name editing ──
function startRename() {
  if (kb.value) {
    nameDraft.value = kb.value.name;
    editingName.value = true;
  }
}
async function commitRename() {
  if (kbId.value && nameDraft.value.trim() && nameDraft.value.trim() !== kb.value?.name) {
    await store.updateKB(kbId.value, nameDraft.value.trim(), null);
  }
  editingName.value = false;
}

function startEditDesc() {
  if (kb.value) {
    descDraft.value = kb.value.description || "";
    editingDesc.value = true;
  }
}
async function commitDesc() {
  const newDesc = descDraft.value.trim();
  if (kbId.value && newDesc !== (kb.value?.description || "")) {
    await store.updateKB(kbId.value, null, newDesc);
  }
  editingDesc.value = false;
}

// ── Upload ──
async function doUpload(filePath: string) {
  if (!kbId.value) return;
  uploadingRef.value = true;
  try {
    await store.uploadDocument(kbId.value, filePath, selectedPath.value);
  } catch (e: any) {
    const msg = String(e);
    uploadError.value = msg.includes("Embedding model mismatch")
      ? t("error.embeddingMismatch")
      : msg;
  }
  uploadingRef.value = false;
}

async function handleUploadClick() {
  if (!kbId.value) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Documents",
          extensions: [
            "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx",
            "png", "jpg", "jpeg", "webp", "gif", "bmp",
            "html", "md", "markdown", "txt", "zip",
          ],
        },
      ],
    });
    if (selected) {
      const files = Array.isArray(selected) ? selected : [selected];
      for (const f of files) await doUpload(f as string);
    }
  } catch (e) {
    console.error(e);
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  dragOver.value = false;
  const files = e.dataTransfer?.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const path = (files[i] as any).path as string | undefined;
      if (path) doUpload(path);
    }
  }
}

// ── Delete document ──
async function handleDeleteConfirm() {
  if (kbId.value && deleteTarget.value) {
    await store.deleteDocument(kbId.value, deleteTarget.value.docId);
    deleteTarget.value = null;
  }
}

// ── Delete KB ──
async function handleDeleteKB() {
  if (kbId.value) {
    await store.deleteKB(kbId.value);
    router.push("/");
  }
  deleteKBTarget.value = false;
}

// ── Reindex ──
async function handleReindexDoc(doc: Document) {
  if (!kbId.value) return;
  await store.reindexDocument(kbId.value, doc.id, doc.name);
}

async function handleReindexAll() {
  if (!kbId.value) return;
  try {
    await ElMessageBox.confirm(
      t("kb.reindexConfirm", { name: kb.value?.name || "" }),
      t("docs.reindexAll"),
      { confirmButtonText: t("docs.reindex"), cancelButtonText: t("kb.cancel"), type: "info" }
    );
    await store.reindexAll(kbId.value);
    ElMessage.success(t("kb.reindexStarted"));
  } catch {
    /* cancelled */
  }
}

// ── Open file / explorer ──
async function handleOpenFile(doc: Document) {
  if (!kbId.value) return;
  const viewParam = doc.file_type === "pdf" ? "?view=pdf" : "";
  router.push(`/kb/${kbId.value}/documents/${doc.id}${viewParam}`);
}

async function handleOpenInExplorer(doc: Document) {
  if (!kbId.value) return;
  try {
    const { revealDocumentInExplorer } = await import("@/services/tauriBridge");
    await revealDocumentInExplorer(kbId.value, doc.id);
  } catch (e) {
    console.error("Failed to open in explorer:", e);
  }
}

// ── Rename document ──
function startDocRename(doc: Document) {
  renamingDocId.value = doc.id;
  renameDraft.value = doc.name;
}
async function commitDocRename(doc: Document) {
  if (!kbId.value || !renameDraft.value.trim() || renameDraft.value.trim() === doc.name) {
    renamingDocId.value = null;
    return;
  }
  try {
    const { renameDocument } = await import("@/services/tauriBridge");
    await renameDocument(kbId.value, doc.id, renameDraft.value.trim());
    await store.loadDocuments(kbId.value);
  } catch (e) {
    console.error("Rename failed:", e);
  }
  renamingDocId.value = null;
}

// ── Create folder ──
async function handleCreateFolder() {
  if (!newFolderName.value.trim() || !kbId.value) return;
  const name = newFolderName.value.trim();
  const fullPath = newFolderParent.value ? `${newFolderParent.value}/${name}` : name;
  newFolderName.value = "";
  showNewFolder.value = false;
  newFolderParent.value = null;
  try {
    const { createFolder } = await import("@/services/tauriBridge");
    await createFolder(kbId.value, fullPath);
    const { listPaths } = await import("@/services/tauriBridge");
    paths.value = await listPaths(kbId.value);
  } catch (e) {
    console.error("Create folder failed:", e);
  }
}

// ── Delete folder ──
async function handleDeleteFolderConfirm() {
  if (!kbId.value || !deletePathTarget.value) return;
  const path = deletePathTarget.value;
  try {
    if (disbandOnly.value) {
      const { deletePath } = await import("@/services/tauriBridge");
      await deletePath(kbId.value, path);
    } else {
      const prefix = path + "/";
      const { deleteDocument } = await import("@/services/tauriBridge");
      const docs = store.documents.filter(
        (d) => d.path === path || (d.path && d.path.startsWith(prefix))
      );
      for (const doc of docs) {
        await deleteDocument(kbId.value, doc.id);
      }
      const { deletePath, removeFolder } = await import("@/services/tauriBridge");
      await deletePath(kbId.value, path);
      await removeFolder(kbId.value, path).catch(() => {});
    }
    paths.value = paths.value.filter((p) => p !== path && !p.startsWith(path + "/"));
    if (selectedPath.value === path || selectedPath.value?.startsWith(path + "/"))
      setSelectedPath(null);
    await store.loadDocuments(kbId.value);
  } catch (e) {
    console.error("Delete folder failed:", e);
  }
  deletePathTarget.value = null;
}

// ── Toggle expand ──
function toggleExpand(docId: string) {
  const next = new Set(expandedDocs.value);
  if (next.has(docId)) next.delete(docId);
  else next.add(docId);
  expandedDocs.value = next;
}

// ── Computed stats ──
const doneCount = computed(() => allDocs.value.filter((d) => d.parse_status === "done").length);
const totalChunks = computed(() => allDocs.value.reduce((sum, d) => sum + d.chunk_count, 0));
const hasIndexedDocs = computed(() => allDocs.value.some((d) => d.chunk_count > 0));

// ── Formatting ──
function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(1) + " KB";
}

function formatProgress(p: { percent: number; stage: string; current: number; total: number } | undefined): string {
  if (!p) return t("kb.indexingProgress", { percent: 0 });
  if (p.stage === "vlm" && p.total > 0) return t("kb.progressVlm", { cur: p.current, total: p.total });
  return t("kb.indexingProgress", { percent: p.percent });
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "kb.statusPending",
    parsing: "kb.statusParsing",
    done: "kb.statusDone",
    failed: "kb.statusFailed",
  };
  return t(map[status] || status);
}

// ── Sub-folders ──
const subFolders = computed(() => {
  const prefix = selectedPath.value ? selectedPath.value + "/" : "";
  return paths.value.filter((p) => {
    if (!p.startsWith(prefix)) return false;
    const rest = p.slice(prefix.length);
    return rest.length > 0 && !rest.includes("/");
  });
});

// ── Documents in current path ──
const docsInPath = computed(() =>
  store.documents.filter((doc) => (doc.path || null) === (selectedPath.value || null))
);

// ── Copy KB ──
async function handleCopyKB() {
  if (kbId.value) {
    await store.copyKB(kbId.value);
    ElMessage.success(t("kb.copyKb"));
  }
}

// ── Refresh ──
async function handleRefresh() {
  if (kbId.value) {
    await store.loadKBs();
    await store.loadDocuments(kbId.value);
  }
}
</script>

<template>
  <div class="kb-settings" v-if="kb">
    <!-- Header -->
    <div class="kb-header">
      <div class="flex items-center gap-3">
        <button class="back-btn" @click="router.push('/')">
          <ArrowLeft :size="18" />
        </button>
        <FolderOpen :size="28" class="header-icon" />
        <div class="flex-1 min-w-0">
          <template v-if="editingName">
            <div class="flex items-center gap-1">
              <input
                v-model="nameDraft"
                class="inline-edit-input"
                autofocus
                @keydown.enter="commitRename"
                @keydown.escape="editingName = false"
                @blur="commitRename"
              />
              <button class="icon-btn-sm text-green-600" @click="commitRename">
                <Check :size="16" />
              </button>
            </div>
          </template>
          <template v-else>
            <h2 class="kb-title">
              {{ kb.name }}
              <button class="icon-btn-sm" @click="startRename" :title="t('kb.rename')">
                <Pencil :size="14" />
              </button>
            </h2>
          </template>

          <template v-if="editingDesc">
            <div class="flex items-start gap-1 mt-1">
              <textarea
                v-model="descDraft"
                class="inline-edit-textarea"
                rows="2"
                autofocus
                :placeholder="t('kb.addDescription')"
                @keydown.enter.exact.prevent="commitDesc"
                @keydown.escape="editingDesc = false"
                @blur="commitDesc"
              />
              <button class="icon-btn-sm text-green-600 shrink-0" @click="commitDesc">
                <Check :size="14" />
              </button>
            </div>
          </template>
          <template v-else>
            <div class="flex items-start gap-1 mt-1 min-w-0">
              <p
                class="kb-description"
                :class="{ 'cursor-pointer hover:text-foreground': kb.description }"
                @click="kb.description && (showDescDialog = true)"
                :title="kb.description ? t('kb.readFullDesc') : undefined"
              >
                {{ kb.description || t("kb.noDescription") }}
              </p>
              <button class="icon-btn-sm shrink-0" @click="startEditDesc" :title="t('kb.editDescription')">
                <Pencil :size="12" />
              </button>
            </div>
          </template>

          <p v-if="kb.embedding_model" class="embedding-badge">
            <span class="model-chip">{{ kb.embedding_model }}</span>
            <span v-if="kb.embedding_dim > 0" class="dim-text">{{ t("kb.embeddingDim", { dim: kb.embedding_dim }) }}</span>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="hasIndexedDocs"
            class="action-btn action-btn-warning"
            @click="handleReindexAll"
            :title="t('kb.reindexAllAction')"
          >
            <RefreshCw :size="14" />
            <span class="hidden sm:inline">{{ t("kb.reindexAllAction") }}</span>
          </button>
          <button class="action-btn action-btn-ghost" @click="handleRefresh" :title="t('kb.refresh')">
            <RefreshCw :size="14" />
          </button>
          <button class="action-btn action-btn-ghost" @click="handleCopyKB" :title="t('kb.copyKb')">
            <Copy :size="14" />
          </button>
          <button
            class="action-btn action-btn-danger"
            @click="deleteKBTarget = true"
            :title="t('kb.deleteKBTooltip')"
          >
            <Trash2 :size="14" />
          </button>
          <button
            class="action-btn action-btn-primary"
            @click="router.push(`/kb/${kb.id}/search`)"
          >
            <Search :size="14" />
            <span class="hidden sm:inline">{{ t("kb.searchBtn") }}</span>
          </button>
        </div>
      </div>

      <!-- Stats pills -->
      <div class="stats-row">
        <div class="stat-chip">
          <FileText :size="14" />
          <span class="stat-label">{{ t("overview.documents") }}</span>
          <span class="stat-value">{{ kb.document_count }}</span>
        </div>
        <div class="stat-chip">
          <CheckCircle :size="14" />
          <span class="stat-label">{{ t("kb.statDone") }}</span>
          <span class="stat-value">{{ doneCount }}</span>
        </div>
        <div class="stat-chip">
          <Layers :size="14" />
          <span class="stat-label">{{ t("overview.chunks") }}</span>
          <span class="stat-value">{{ totalChunks }}</span>
        </div>
      </div>
    </div>

    <!-- File Manager -->
    <div class="file-manager">
      <!-- Toolbar -->
      <div class="toolbar">
        <button class="toolbar-btn toolbar-btn-primary" @click="handleUploadClick">
          <Upload :size="14" /> {{ t("kb.upload") }}
        </button>
        <button
          class="toolbar-btn toolbar-btn-ghost"
          @click="
            showNewFolder = true;
            newFolderParent = selectedPath;
          "
        >
          <Plus :size="14" /> {{ t("kb.newFolder") }}
        </button>
        <button class="toolbar-btn toolbar-btn-icon" @click="handleRefresh" :title="t('kb.refresh')">
          <RefreshCw :size="14" />
        </button>
        <!-- Breadcrumb -->
        <div class="breadcrumb">
          <span class="breadcrumb-seg" @click="setSelectedPath(null)">{{ t("kb.rootBreadcrumb") }}</span>
          <template v-if="selectedPath">
            <template v-for="(seg, i) in selectedPath.split('/')" :key="i">
              <span class="breadcrumb-slash">/</span>
              <span
                class="breadcrumb-seg"
                :class="{ active: i === selectedPath.split('/').length - 1 }"
                @click="setSelectedPath(selectedPath.split('/').slice(0, i + 1).join('/'))"
              >
                {{ seg }}
              </span>
            </template>
          </template>
        </div>
        <span class="toolbar-count">
          {{ t("kb.itemsCount", { count: docsInPath.length }) }}
        </span>
      </div>

      <!-- New folder input -->
      <div v-if="showNewFolder" class="new-folder-row">
        <FolderOpen :size="16" class="text-amber-500 shrink-0" />
        <input
          v-model="newFolderName"
          class="new-folder-input"
          autofocus
          :placeholder="t('kb.folderNamePlaceholder')"
          @keydown.enter="handleCreateFolder"
          @keydown.escape="
            showNewFolder = false;
            newFolderParent = null;
          "
        />
        <button class="toolbar-btn toolbar-btn-primary" @click="handleCreateFolder">{{ t("kb.createBtnLabel") }}</button>
        <button
          class="toolbar-btn toolbar-btn-ghost"
          @click="
            showNewFolder = false;
            newFolderParent = null;
          "
        >
          {{ t("kb.cancel") }}
        </button>
      </div>

      <!-- Explorer list -->
      <div
        class="explorer-list"
        :class="{ 'drag-over': dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop="handleDrop"
      >
        <!-- Empty state -->
        <div
          v-if="store.documents.length === 0 && paths.length === 0"
          class="empty-state"
        >
          <template v-if="uploadingRef || loadingDocs">
            <Loader2 :size="32" class="spin" />
            <p>{{ t("kb.loadingDocuments") }}</p>
          </template>
          <template v-else>
            <FolderOpen :size="40" class="empty-icon" />
            <p>{{ t("kb.dropHint") }}</p>
          </template>
        </div>

        <template v-else>
          <div class="explorer-items">
            <!-- ".." parent directory -->
            <div
              v-if="selectedPath"
              class="explorer-item"
              @click="
                setSelectedPath(
                  selectedPath.includes('/')
                    ? selectedPath.split('/').slice(0, -1).join('/')
                    : null
                )
              "
            >
              <div class="explorer-item-main">
                <FolderOpen :size="16" class="text-amber-500 shrink-0" />
                <span class="text-muted">..</span>
              </div>
            </div>

            <!-- Sub-folders -->
            <div
              v-for="fullPath in subFolders"
              :key="'folder-' + fullPath"
              class="explorer-item"
              @dblclick="setSelectedPath(fullPath)"
            >
              <div class="explorer-item-main" @click="setSelectedPath(fullPath)">
                <FolderOpen :size="16" class="text-amber-500 shrink-0" />
                <span class="font-medium truncate">{{ fullPath.split('/').pop() }}</span>
                <span class="type-badge">{{ t("kb.folderBadge") }}</span>
              </div>
              <div class="explorer-item-actions">
                <button
                  class="icon-btn-xs hover:text-red-500"
                  @click.stop="
                    deletePathTarget = fullPath;
                    disbandOnly = false;
                  "
                  :title="t('kb.deleteFolder')"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>

            <!-- Documents -->
            <template v-for="doc in docsInPath" :key="doc.id">
              <div class="explorer-item-wrapper">
                <div
                  class="explorer-item"
                  :class="{
                    'is-part': !!doc.parent_doc_id,
                    'is-failed': doc.parse_status === 'failed',
                  }"
                >
                  <div class="explorer-item-main">
                    <!-- Expand chevron for parent docs -->
                    <button
                      v-if="doc.parts && doc.parts.length > 0"
                      class="icon-btn-xs shrink-0"
                      @click.stop="toggleExpand(doc.id)"
                    >
                      <ChevronDown v-if="expandedDocs.has(doc.id)" :size="14" />
                      <ChevronRight v-else :size="14" />
                    </button>

                    <FileText
                      :size="16"
                      :class="doc.parent_doc_id ? 'text-muted-foreground' : 'text-primary'"
                      class="shrink-0"
                    />

                    <!-- Rename input -->
                    <template v-if="renamingDocId === doc.id">
                      <div class="flex items-center gap-1" @click.stop>
                        <input
                          v-model="renameDraft"
                          class="rename-input"
                          autofocus
                          @keydown.enter="commitDocRename(doc)"
                          @keydown.escape="renamingDocId = null"
                          @blur="commitDocRename(doc)"
                        />
                        <button class="icon-btn-xs text-green-600" @click="commitDocRename(doc)">
                          <Check :size="12" />
                        </button>
                      </div>
                    </template>
                    <template v-else>
                      <span
                        class="doc-name"
                        :class="{ 'text-muted': !!doc.parent_doc_id }"
                        @click="
                          doc.parts?.length
                            ? toggleExpand(doc.id)
                            : (tabStore.openTab({ id: doc.id, title: doc.name, url: `/kb/${kb!.id}/documents/${doc.id}` }),
                            router.push(`/kb/${kb!.id}/documents/${doc.id}`))
                        "
                        :title="doc.name"
                      >
                        {{ doc.name }}
                      </span>
                    </template>

                    <!-- Part count badge -->
                    <span v-if="doc.parts && doc.parts.length > 0" class="part-badge">
                      {{ t("kb.partsCount", { count: doc.parts.length }) }}
                    </span>

                    <span class="file-meta">
                      {{ formatFileSize(doc.file_size) }} .{{ doc.file_type }}
                    </span>

                    <!-- Status -->
                    <span class="status-badge">
                      <template
                        v-if="
                          doc.parts?.length &&
                          doc.parts.reduce((s, p) => s + p.chunk_count, 0) > 0
                        "
                      >
                        <span class="text-green-600">
                          {{ doc.parts.reduce((s, p) => s + p.chunk_count, 0) }}c
                        </span>
                      </template>
                      <template v-else-if="store.indexingProgress[doc.id]">
                        <span class="text-blue-600">
                          {{ formatProgress(store.indexingProgress[doc.id]) }}
                        </span>
                      </template>
                      <template v-else-if="doc.parse_status === 'failed'">
                        <span
                          class="text-red-500 cursor-pointer hover:underline"
                          @click.stop="errorDetailTarget = doc.parse_error ?? null"
                        >
                          {{ t("kb.statusFailed") }}
                        </span>
                      </template>
                      <template v-else-if="doc.chunk_count > 0">
                        <span class="text-green-600">{{ doc.chunk_count }}c</span>
                      </template>
                      <template v-else-if="doc.parse_status === 'parsing' && parseProgress[doc.id]">
                        <span>{{ parseProgress[doc.id].percent }}%</span>
                      </template>
                      <template v-else>
                        <span>{{ statusLabel(doc.parse_status) }}</span>
                      </template>
                    </span>
                  </div>

                  <div class="explorer-item-actions">
                    <!-- Reindex -->
                    <template v-if="doc.parts?.length">
                      <button
                        class="icon-btn-xs hover:text-amber-600"
                        @click.stop="doc.parts!.forEach((p) => handleReindexDoc(p))"
                        :title="t('kb.reindexAllPartsTooltip')"
                      >
                        <RefreshCw :size="12" />
                      </button>
                    </template>
                    <template v-else-if="doc.chunk_count > 0">
                      <button
                        class="icon-btn-xs hover:text-amber-600"
                        @click.stop="handleReindexDoc(doc)"
                        :title="t('kb.reindexTooltip')"
                      >
                        <RefreshCw :size="12" />
                      </button>
                    </template>
                    <!-- Move/Copy -->
                    <button
                      v-if="!doc.parent_doc_id"
                      class="icon-btn-xs"
                      @click.stop="openMoveCopy(doc)"
                      :title="t('kb.moveCopy')"
                    >
                      <GripHorizontal :size="12" />
                    </button>
                    <!-- Rename -->
                    <button
                      class="icon-btn-xs"
                      @click.stop="startDocRename(doc)"
                      :title="t('kb.rename')"
                    >
                      <Pencil :size="12" />
                    </button>
                    <!-- Open in explorer -->
                    <button
                      class="icon-btn-xs"
                      @click.stop="handleOpenInExplorer(doc)"
                      :title="t('kb.openLocationTooltip')"
                    >
                      <FolderSearch :size="12" />
                    </button>
                    <!-- Open file -->
                    <button
                      class="icon-btn-xs"
                      @click.stop="handleOpenFile(doc)"
                      :title="t('kb.openFileTooltip')"
                    >
                      <ExternalLink :size="12" />
                    </button>
                    <!-- Delete -->
                    <button
                      class="icon-btn-xs hover:text-red-500"
                      @click.stop="deleteTarget = { docId: doc.id, docName: doc.name }"
                      :title="t('kb.deleteTooltip')"
                    >
                      <Trash2 :size="12" />
                    </button>
                  </div>
                </div>

                <!-- Expanded parts -->
                <template v-if="doc.parts && doc.parts.length > 0 && expandedDocs.has(doc.id)">
                  <div
                    v-for="part in doc.parts"
                    :key="part.id"
                    class="explorer-item is-part ml-6"
                    :class="{ 'is-failed': part.parse_status === 'failed' }"
                  >
                    <div class="explorer-item-main">
                      <FileText :size="14" class="text-muted-foreground shrink-0" />
                      <span
                        class="doc-name text-muted"
                        @click="
                          tabStore.openTab({ id: part.id, title: part.name, url: `/kb/${kb!.id}/documents/${part.id}` });
                          router.push(`/kb/${kb!.id}/documents/${part.id}`);
                        "
                        :title="part.name"
                      >
                        {{ part.name }}
                      </span>
                      <span class="file-meta">{{ formatFileSize(part.file_size) }}</span>
                      <span class="status-badge">
                        <template v-if="store.indexingProgress[part.id]">
                          <span class="text-blue-600">
                            {{ formatProgress(store.indexingProgress[part.id]) }}
                          </span>
                        </template>
                        <template v-else-if="part.parse_status === 'failed'">
                          <span
                            class="text-red-500 cursor-pointer hover:underline"
                            @click.stop="errorDetailTarget = part.parse_error ?? null"
                          >
                            {{ t("kb.statusFailed") }}
                          </span>
                        </template>
                        <template v-else-if="part.chunk_count > 0">
                          <span class="text-green-600">{{ part.chunk_count }}c</span>
                        </template>
                        <template
                          v-else-if="
                            part.parse_status === 'parsing' && parseProgress[part.id]
                          "
                        >
                          <span>{{ parseProgress[part.id].percent }}%</span>
                        </template>
                        <template v-else>
                          <span>{{ statusLabel(part.parse_status) }}</span>
                        </template>
                      </span>
                    </div>
                    <div class="explorer-item-actions">
                      <button
                        v-if="part.chunk_count > 0"
                        class="icon-btn-xs hover:text-amber-600"
                        @click.stop="handleReindexDoc(part)"
                        :title="t('kb.reindexTooltip')"
                      >
                        <RefreshCw :size="12" />
                      </button>
                      <button
                        class="icon-btn-xs"
                        @click.stop="startDocRename(part)"
                        :title="t('kb.rename')"
                      >
                        <Pencil :size="12" />
                      </button>
                      <button
                        class="icon-btn-xs"
                        @click.stop="handleOpenInExplorer(part)"
                        :title="t('kb.openLocationTooltip')"
                      >
                        <FolderSearch :size="12" />
                      </button>
                      <button
                        class="icon-btn-xs"
                        @click.stop="handleOpenFile(part)"
                        :title="t('kb.openFileTooltip')"
                      >
                        <ExternalLink :size="12" />
                      </button>
                      <button
                        class="icon-btn-xs hover:text-red-500"
                        @click.stop="deleteTarget = { docId: part.id, docName: part.name }"
                        :title="t('kb.deleteTooltip')"
                      >
                        <Trash2 :size="12" />
                      </button>
                    </div>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>

    <!-- Delete doc confirm -->
    <ConfirmDialog
      :visible="deleteTarget !== null"
      :title="t('kb.deleteDocTitle')"
      :message="deleteTarget ? t('kb.deleteDocMsg', { name: deleteTarget.docName }) : ''"
      danger
      @confirm="handleDeleteConfirm"
      @cancel="deleteTarget = null"
    />

    <!-- Delete KB confirm -->
    <ConfirmDialog
      :visible="deleteKBTarget"
      :title="t('kb.deleteKBTitle')"
      :message="kb ? t('kb.deleteKBMsg', { name: kb.name }) : ''"
      danger
      @confirm="handleDeleteKB"
      @cancel="deleteKBTarget = false"
    />

    <!-- Delete folder confirm -->
    <el-dialog
      v-model="deletePathTarget"
      :title="t('kb.deleteFolderTitle')"
      width="420px"
      :close-on-click-modal="false"
      @update:model-value="
        (v: boolean) => {
          if (!v) deletePathTarget = null;
        }
      "
    >
      <p style="margin: 0 0 16px; line-height: 1.6">
        {{ t("kb.deleteFolderMsg", { path: deletePathTarget || "" }) }}
      </p>
      <label class="flex items-center gap-2 cursor-pointer">
        <input v-model="disbandOnly" type="checkbox" class="w-4 h-4 rounded" />
        <span style="font-size: 13px">{{ t("kb.disbandOnlyLabel") }}</span>
      </label>
      <template #footer>
        <el-button size="small" @click="deletePathTarget = null">{{ t("kb.cancel") }}</el-button>
        <el-button
          size="small"
          :type="disbandOnly ? 'warning' : 'danger'"
          @click="handleDeleteFolderConfirm"
        >
          {{ disbandOnly ? t("kb.disbandBtn") : t("kb.deleteFolderBtn") }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Description dialog -->
    <el-dialog
      v-model="showDescDialog"
      :title="kb.name"
      width="500px"
      :close-on-click-modal="true"
    >
      <p style="white-space: pre-wrap; word-break: break-word; font-size: 14px; color: var(--el-text-color-secondary); line-height: 1.7;">
        {{ kb.description }}
      </p>
    </el-dialog>

    <!-- Error detail dialog -->
    <el-dialog
      v-model="errorDetailTarget"
      :title="t('kb.mineruParseError')"
      width="500px"
      :close-on-click-modal="true"
      @update:model-value="
        (v: boolean) => {
          if (!v) errorDetailTarget = null;
        }
      "
    >
      <template #header>
        <div class="flex items-center justify-between w-full">
          <span style="color: var(--el-color-danger); font-weight: 600">{{ t("kb.mineruParseError") }}</span>
          <button
            class="icon-btn-sm"
            @click="copyErrorDetail"
            :title="t('app.copyError')"
          >
            <Check v-if="errorCopied" :size="14" class="text-green-500" />
            <Copy v-else :size="14" />
          </button>
        </div>
      </template>
      <pre
        style="
          white-space: pre-wrap;
          word-break: break-all;
          font-size: 12px;
          max-height: 400px;
          overflow-y: auto;
          background: var(--el-fill-color-lighter);
          padding: 12px;
          border-radius: 6px;
          margin: 0;
        "
      >{{ errorDetailTarget }}</pre>
    </el-dialog>

    <!-- Upload error -->
    <ErrorDialog
      :visible="!!uploadError"
      :title="t('kb.uploadError')"
      :message="uploadError"
      @update:visible="uploadError = ''"
    />

    <!-- Move/Copy dialog -->
    <MoveCopyDialog
      v-if="moveCopyVisible && kbId"
      :visible="moveCopyVisible"
      :kb-id="kbId"
      :doc-id="moveCopyDocId"
      :doc-name="moveCopyDocName"
      :action="moveCopyAction"
      @update:visible="moveCopyVisible = $event"
      @done="onMoveCopyDone"
    />
  </div>

  <!-- KB not found -->
  <div v-else class="kb-not-found">
    <Database :size="48" class="not-found-icon" />
    <p>{{ t("kb.notFound") }}</p>
    <el-button size="small" @click="router.push('/')">{{ t("kb.backToDashboard") }}</el-button>
  </div>
</template>

<style scoped>
.kb-settings {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.kb-header {
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
  flex-shrink: 0;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  transition: all 150ms;
}
.back-btn:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}

.header-icon {
  color: var(--el-color-primary);
}

.kb-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  word-break: break-word;
}

.kb-description {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin: 0;
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
}

.embedding-badge {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.model-chip {
  font-size: 10px;
  padding: 2px 8px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  border-radius: 10px;
  font-weight: 600;
}

.dim-text {
  font-size: 11px;
  color: var(--el-text-color-disabled);
}

.inline-edit-input {
  font-size: 22px;
  font-weight: 700;
  padding: 4px 8px;
  border: 1px solid var(--el-color-primary);
  border-radius: 6px;
  outline: none;
  background: var(--el-bg-color);
  width: 100%;
  max-width: 400px;
}

.inline-edit-textarea {
  font-size: 13px;
  padding: 4px 8px;
  border: 1px solid var(--el-color-primary);
  border-radius: 6px;
  outline: none;
  resize: none;
  background: var(--el-bg-color);
  width: 100%;
  max-width: 400px;
}

.icon-btn-sm {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  border-radius: 4px;
  transition: all 120ms;
}
.icon-btn-sm:hover {
  background: var(--el-fill-color);
}

.icon-btn-xs {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--el-text-color-disabled);
  cursor: pointer;
  border-radius: 4px;
  transition: all 120ms;
}
.icon-btn-xs:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-regular);
}

.stats-row {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 14px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 20px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.stat-label {
  color: var(--el-text-color-secondary);
}

.stat-value {
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 150ms;
  white-space: nowrap;
}
.action-btn-primary {
  background: var(--el-color-primary);
  color: #fff;
}
.action-btn-primary:hover {
  opacity: 0.9;
}
.action-btn-ghost {
  border-color: var(--el-border-color);
  background: transparent;
  color: var(--el-text-color-secondary);
}
.action-btn-ghost:hover {
  background: var(--el-fill-color);
}
.action-btn-warning {
  background: var(--el-color-warning-light-9);
  border-color: var(--el-color-warning-light-5);
  color: var(--el-color-warning);
}
.action-btn-warning:hover {
  background: var(--el-color-warning-light-8);
}
.action-btn-danger {
  border-color: var(--el-color-danger-light-5);
  color: var(--el-color-danger);
  background: transparent;
}
.action-btn-danger:hover {
  background: var(--el-color-danger-light-9);
}

/* File Manager */
.file-manager {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 120ms;
  white-space: nowrap;
}
.toolbar-btn-primary {
  background: var(--el-color-primary);
  color: #fff;
}
.toolbar-btn-primary:hover {
  opacity: 0.9;
}
.toolbar-btn-ghost {
  border-color: var(--el-border-color);
  background: transparent;
  color: var(--el-text-color-secondary);
}
.toolbar-btn-ghost:hover {
  background: var(--el-fill-color);
}
.toolbar-btn-icon {
  border: none;
  background: transparent;
  color: var(--el-text-color-secondary);
  padding: 5px;
}
.toolbar-btn-icon:hover {
  background: var(--el-fill-color);
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 8px;
  overflow: hidden;
}
.breadcrumb-seg {
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  white-space: nowrap;
}
.breadcrumb-seg:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}
.breadcrumb-seg.active {
  color: var(--el-text-color-primary);
  font-weight: 600;
}
.breadcrumb-slash {
  color: var(--el-text-color-disabled);
  flex-shrink: 0;
}

.toolbar-count {
  font-size: 12px;
  color: var(--el-text-color-disabled);
  margin-left: auto;
}

.new-folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}
.new-folder-input {
  flex: 1;
  font-size: 13px;
  padding: 4px 8px;
  border: 1px solid var(--el-color-primary);
  border-radius: 6px;
  outline: none;
  background: var(--el-bg-color);
}

/* Explorer */
.explorer-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.explorer-list.drag-over {
  background: var(--el-color-primary-light-9);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 24px;
  color: var(--el-text-color-disabled);
  text-align: center;
  gap: 12px;
}
.empty-icon {
  opacity: 0.3;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.explorer-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
}

.explorer-item-wrapper {
  display: flex;
  flex-direction: column;
}

.explorer-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  transition: all 120ms;
  background: var(--el-bg-color);
}
.explorer-item:hover {
  border-color: var(--el-color-primary-light-5);
}
.explorer-item.is-part {
  background: var(--el-fill-color-lighter);
  border-style: dashed;
}
.explorer-item.is-failed {
  border-color: var(--el-color-danger-light-5);
  background: var(--el-color-danger-light-9);
}

.explorer-item-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.explorer-item-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  margin-left: 8px;
}

.doc-name {
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-name:hover {
  color: var(--el-color-primary);
}
.doc-name.text-muted {
  color: var(--el-text-color-secondary);
}

.text-muted {
  color: var(--el-text-color-secondary);
}

.text-muted-foreground {
  color: var(--el-text-color-disabled);
}

.font-medium {
  font-weight: 500;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.part-badge {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  border-radius: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.type-badge {
  font-size: 10px;
  color: var(--el-text-color-disabled);
  white-space: nowrap;
}

.file-meta {
  font-size: 10px;
  color: var(--el-text-color-disabled);
  white-space: nowrap;
}

.status-badge {
  font-size: 10px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.rename-input {
  font-size: 12px;
  padding: 2px 6px;
  border: 1px solid var(--el-color-primary);
  border-radius: 4px;
  outline: none;
  width: 140px;
  background: var(--el-bg-color);
}

.kb-not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 24px;
  text-align: center;
  gap: 12px;
  color: var(--el-text-color-secondary);
}

.not-found-icon {
  color: var(--el-border-color);
}

/* responsive */
@media (max-width: 640px) {
  .hidden.sm\:inline {
    display: none;
  }
}
</style>