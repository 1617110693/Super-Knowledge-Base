<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { Plus, Trash2, RefreshCw, Eye, FileText, FolderOpen } from "lucide-vue-next";
import { useKBStore } from "@/stores/kbStore";
import { ElMessage, ElMessageBox } from "element-plus";
import type { Document } from "@/types";

const props = defineProps<{
  kbId: string;
}>();

const router = useRouter();
const store = useKBStore();

const selectedDoc = ref<Document | null>(null);
const uploadLoading = ref(false);

const documents = computed(() => store.documents);
const indexingProgress = computed(() => store.indexingProgress);

onMounted(() => {
  if (props.kbId) {
    store.loadDocuments(props.kbId);
  }
});

watch(
  () => props.kbId,
  (newId) => {
    if (newId) {
      store.loadDocuments(newId);
    }
  }
);

function getStatusType(status: string): string {
  switch (status) {
    case "done":
      return "success";
    case "parsing":
    case "pending":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "info";
  }
}

function getProgress(doc: Document): { percent: number; stage: string } | null {
  return indexingProgress.value[doc.id] ?? null;
}

async function handleUpload() {
  let filePath: string | null = null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    filePath = await open({
      multiple: false,
      filters: [
        {
          name: "Documents",
          extensions: [
            "pdf", "docx", "pptx", "xlsx", "md", "txt",
            "html", "htm", "csv", "json", "xml", "epub",
            "png", "jpg", "jpeg",
          ],
        },
      ],
    });
  } catch {
    filePath = prompt("Enter the full file path:") ?? null;
  }
  if (!filePath) return;

  uploadLoading.value = true;
  try {
    await store.uploadDocument(props.kbId, filePath);
    ElMessage.success("Document uploaded and processing started");
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    uploadLoading.value = false;
  }
}

async function handleDelete(doc: Document) {
  try {
    await ElMessageBox.confirm(
      `Delete "${doc.name}"? This action cannot be undone.`,
      "Delete Document",
      { confirmButtonText: "Delete", cancelButtonText: "Cancel", type: "warning" }
    );
    await store.deleteDocument(props.kbId, doc.id);
    ElMessage.success("Document deleted");
  } catch {
    // cancelled
  }
}

function handleView(doc: Document) {
  // Open the document preview in a new tab or navigate
  const url = router.resolve({
    name: "document-preview",
    params: { kbId: props.kbId, docId: doc.id },
  });
  window.open(url.href, "_blank");
}

async function handleReindex(doc: Document) {
  try {
    await store.reindexDocument(props.kbId, doc.id, doc.name);
    ElMessage.success("Re-index started");
  } catch (e) {
    ElMessage.error(String(e));
  }
}

function navigateToView(doc: Document) {
  router.push({
    name: "document-preview",
    params: { kbId: props.kbId, docId: doc.id },
  });
}
</script>

<template>
  <div class="document-manager">
    <!-- Toolbar -->
    <div class="doc-toolbar">
      <span class="doc-count" v-if="documents.length">
        {{ documents.length }} document{{ documents.length !== 1 ? "s" : "" }}
      </span>
      <el-button size="small" type="primary" :loading="uploadLoading" @click="handleUpload">
        <Plus :size="14" style="margin-right: 4px" />
        Upload
      </el-button>
    </div>

    <!-- Loading -->
    <div v-if="store.loading && documents.length === 0" class="loading-state">
      <div class="loading-spinner" />
      <p>Loading documents...</p>
    </div>

    <!-- Empty -->
    <div v-else-if="documents.length === 0" class="empty-state">
      <FolderOpen :size="40" class="empty-icon" />
      <p class="empty-title">No documents yet</p>
      <p class="empty-hint">Upload a PDF, DOCX, or other document to get started</p>
    </div>

    <!-- Table -->
    <el-table
      v-else
      :data="documents"
      style="width: 100%"
      size="small"
      stripe
      highlight-current-row
      @row-click="navigateToView"
    >
      <el-table-column label="Name" min-width="200">
        <template #default="{ row }: { row: Document }">
          <div class="doc-name-cell">
            <FileText :size="14" class="doc-type-icon" />
            <span class="doc-name-text">{{ row.name }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="Type" width="80" align="center">
        <template #default="{ row }: { row: Document }">
          <span class="doc-type">{{ row.file_type?.toUpperCase() || "--" }}</span>
        </template>
      </el-table-column>

      <el-table-column label="Status" width="110" align="center">
        <template #default="{ row }: { row: Document }">
          <div class="status-cell">
            <el-tag :type="getStatusType(row.parse_status)" size="small" effect="plain">
              {{ row.parse_status }}
            </el-tag>
            <div
              v-if="getProgress(row)"
              class="index-progress"
              :title="`${getProgress(row)!.stage}: ${getProgress(row)!.percent.toFixed(0)}%`"
            >
              <el-progress
                :percentage="Math.round(getProgress(row)!.percent)"
                :stroke-width="4"
                size="small"
              />
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="Chunks" width="80" align="center">
        <template #default="{ row }: { row: Document }">
          <span class="chunk-count">{{ row.chunk_count }}</span>
        </template>
      </el-table-column>

      <el-table-column label="Actions" width="180" align="center" fixed="right">
        <template #default="{ row }: { row: Document }">
          <div class="action-btns">
            <el-tooltip content="View document" placement="top">
              <el-button size="small" circle @click.stop="handleView(row)">
                <Eye :size="14" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="Re-index" placement="top">
              <el-button
                size="small"
                circle
                :loading="!!getProgress(row)"
                @click.stop="handleReindex(row)"
              >
                <RefreshCw :size="14" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="Delete" placement="top">
              <el-button size="small" circle type="danger" @click.stop="handleDelete(row)">
                <Trash2 :size="14" />
              </el-button>
            </el-tooltip>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.document-manager {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.doc-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.doc-count {
  font-size: 13px;
  color: var(--text-secondary);
}

.doc-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.doc-type-icon {
  color: var(--accent-color);
  flex-shrink: 0;
}

.doc-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-type {
  font-size: 11px;
  font-family: "SF Mono", "Fira Code", monospace;
  color: var(--text-secondary);
}

.status-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.chunk-count {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.action-btns {
  display: flex;
  gap: 4px;
  justify-content: center;
}

.index-progress {
  width: 80px;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 24px;
  text-align: center;
  gap: 8px;
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-icon {
  color: var(--border-color);
}

.empty-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0;
}

.empty-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

:deep(.el-table) {
  --el-table-header-bg-color: var(--surface-raised);
  --el-table-tr-bg-color: transparent;
  --el-table-border-color: var(--border-color);
  --el-table-text-color: var(--text-primary);
  --el-table-header-text-color: var(--text-secondary);
}

:deep(.el-table__row) {
  cursor: pointer;
}
</style>
