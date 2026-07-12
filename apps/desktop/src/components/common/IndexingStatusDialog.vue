<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import type { Document } from "@/types";
import { pollIndexProgress, pollVlmStatus } from "@/services/pythonClient";
import { RefreshCw, AlertCircle, CheckCircle2, Loader2 } from "lucide-vue-next";

const props = defineProps<{
  visible: boolean;
  doc: Document | null;
  progress: {
    percent: number;
    stage: string;
    current: number;
    total: number;
    taskId?: string;
    vlm_status?: string;
    vlm_current?: number;
    vlm_total?: number;
    vlm_error?: string;
    error?: string;
  } | null;
  kbId: string;
}>();

const emit = defineEmits<{
  (e: "update:visible", val: boolean): void;
  (e: "retry"): void;
}>();

// ── Stage label ──
const stageLabel = computed(() => {
  const p = props.progress;
  if (!p) {
    // When progress is null but doc exists, show completion status
    if (props.doc?.chunk_count && props.doc.chunk_count > 0) {
      return `已完成, ${props.doc.chunk_count} chunks`;
    }
    if (props.doc?.parts?.length) {
      return "分片文档";
    }
    return "--";
  }
  switch (p.stage) {
    case "chunking": return "分块中...";
    case "vlm": return "图像分析中...";
    case "embedding": return "向量化中...";
    case "storing": return "存储中...";
    case "done": return "已完成";
    case "error": return "索引失败";
    case "starting": return "启动中...";
    default: return p.stage;
  }
});

const isRunning = computed(() => {
  const p = props.progress;
  if (!p) return false;
  return p.stage !== "done" && p.stage !== "error" && !p.error;
});

const progressColor = computed(() => {
  if (props.progress?.stage === "error" || props.progress?.error) return "#F56C6C";
  if (props.progress?.stage === "done") return "#67C23A";
  return "#409EFF";
});

const hasError = computed(() => !!props.progress?.error);

// ── VLM status ──
const vlmActive = computed(() => {
  const p = props.progress;
  if (!p) return false;
  return p.vlm_status === "processing" || p.vlm_status === "pending";
});

const vlmStatusLabel = computed(() => {
  const p = props.progress;
  if (!p?.vlm_status) return "";
  if (p.vlm_status === "processing") return `VLM 处理中: ${p.vlm_current ?? 0}/${p.vlm_total ?? 0}`;
  if (p.vlm_status === "pending") return "VLM 等待处理";
  if (p.vlm_status === "done") return "VLM 已完成";
  if (p.vlm_status === "error") return `VLM 失败: ${p.vlm_error ?? ""}`;
  return p.vlm_status;
});

// ── Parts summary (for parent docs) ──
const partsStatus = computed(() => {
  const parts = props.doc?.parts;
  if (!parts || parts.length === 0) return null;
  const total = parts.length;
  const indexed = parts.filter(p => p.chunk_count > 0).length;
  const totalChunks = parts.reduce((s, p) => s + p.chunk_count, 0);
  const inProgress = parts.filter(p => props.progress?.taskId && false).length;
  return { total, indexed, totalChunks, inProgress };
});

// ── Parent doc mode: show parts list in a table ──
const isParentDoc = computed(() => !!(props.doc?.parts && props.doc.parts.length > 0));

const partsWithProgress = computed(() => {
  if (!props.doc?.parts) return [];
  return props.doc.parts.map(p => ({
    doc: p,
    progress: p.chunk_count > 0
      ? { stage: "done", percent: 100, current: p.chunk_count, total: p.chunk_count }
      : null,
  }));
});

// ── Background polling ──
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling() {
  const taskId = props.progress?.taskId;
  if (!taskId) return;
  pollTimer = setInterval(async () => {
    try {
      const p = await pollIndexProgress(taskId);
      // We update the parent via emit in this case since props aren't mutable
      // The parent will re-render with new data
    } catch { /* keep current */ }
  }, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

watch(() => props.visible, (v) => {
  if (v) startPolling();
  else stopPolling();
});

onUnmounted(stopPolling);

function handleRetry() {
  emit("retry");
  emit("update:visible", false);
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="`索引状态: ${doc?.name ?? ''}`"
    width="520px"
    @update:model-value="(val: boolean) => emit('update:visible', val)"
    :close-on-click-modal="false"
  >
    <div class="status-body">
      <!-- ── Main status area ── -->
      <div class="main-status">
        <div class="status-icon-row">
          <Loader2 v-if="isRunning" :size="22" class="spin text-accent" />
          <CheckCircle2 v-else-if="progress?.stage === 'done' || (progress === null && doc?.chunk_count && doc.chunk_count > 0)" :size="22" class="text-success" />
          <AlertCircle v-else-if="hasError || progress?.stage === 'error'" :size="22" class="text-danger" />
          <span class="stage-title">{{ stageLabel }}</span>
        </div>
        <el-progress
          v-if="progress && isRunning"
          :percentage="Math.round(progress.percent)"
          :color="progressColor"
          :stroke-width="10"
        />
        <el-progress
          v-else-if="progress && progress.stage === 'done'"
          :percentage="100"
          :color="progressColor"
          :stroke-width="10"
        />
        <el-progress
          v-else-if="progress && hasError"
          :percentage="100"
          :color="'#F56C6C'"
          :stroke-width="10"
        />
      </div>

      <!-- ── Key metrics (2-col grid) ── -->
      <div v-if="progress" class="metrics-grid">
        <div class="metric-item">
          <span class="metric-label">阶段</span>
          <span class="metric-value">
            <el-tag size="small" :type="progress.stage === 'error' ? 'danger' : progress.stage === 'done' ? 'success' : ''">
              {{ progress.stage }}
            </el-tag>
          </span>
        </div>
        <div class="metric-item">
          <span class="metric-label">进度</span>
          <span class="metric-value">{{ progress.current }}/{{ progress.total }}</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Chunks</span>
          <span class="metric-value">{{ doc?.chunk_count ?? 0 }}</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">任务 ID</span>
          <code class="task-id">{{ progress.taskId ?? '--' }}</code>
        </div>
      </div>

      <!-- ── VLM status area (only when active) ── -->
      <div v-if="vlmActive" class="vlm-section">
        <div class="vlm-row">
          <Loader2 :size="16" class="spin" />
          <span>{{ vlmStatusLabel }}</span>
        </div>
      </div>
      <div v-else-if="progress?.vlm_status === 'error'" class="vlm-section vlm-error">
        <AlertCircle :size="16" class="text-danger" />
        <span>{{ vlmStatusLabel }}</span>
      </div>

      <!-- ── Error area ── -->
      <el-alert
        v-if="progress?.error"
        :title="'索引错误'"
        :description="progress.error"
        type="error"
        show-icon
        :closable="false"
        class="error-alert"
      />

      <!-- ── Parent doc: parts list ── -->
      <div v-if="isParentDoc" class="parts-section">
        <div class="parts-header">
          子分片 ({{ partsStatus?.total ?? 0 }}) — {{ partsStatus?.indexed ?? 0 }} 个已索引, 共 {{ partsStatus?.totalChunks ?? 0 }} chunks
        </div>
        <div class="parts-table">
          <div v-for="p in props.doc!.parts!" :key="p.id" class="part-row">
            <span class="part-name" :title="p.name">{{ p.name }}</span>
            <span class="part-status">
              <template v-if="p.chunk_count > 0">
                <span class="text-success">{{ p.chunk_count }}c</span>
              </template>
              <template v-else-if="p.parse_status === 'failed'">
                <span class="text-danger">失败</span>
              </template>
              <template v-else>
                <span class="text-muted">{{ p.parse_status }}</span>
              </template>
            </span>
          </div>
        </div>
      </div>

      <!-- ── Empty state for single doc with no progress ── -->
      <div v-if="!progress && !isParentDoc && !doc?.chunk_count" class="empty-state">
        <span class="text-muted">暂无索引数据</span>
      </div>
    </div>

    <template #footer>
      <div class="footer-btns">
        <el-button size="small" @click="handleRetry">重试索引</el-button>
        <el-button size="small" @click="emit('update:visible', false)">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.status-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Main status */
.main-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.status-icon-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stage-title {
  font-size: 16px;
  font-weight: 600;
}

/* Metrics grid */
.metrics-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  background: var(--surface-raised, #f9fafb);
  padding: 12px;
  border-radius: 6px;
}

.metric-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.metric-label {
  font-size: 11px;
  color: var(--text-secondary, #888);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.metric-value {
  font-size: 13px;
  font-weight: 500;
}

.task-id {
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 10px;
  background: var(--surface-raised, #eee);
  padding: 1px 4px;
  border-radius: 2px;
  word-break: break-all;
}

/* VLM section */
.vlm-section {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #ecf5ff;
  border-radius: 6px;
  font-size: 13px;
}

.vlm-error {
  background: #fef0f0;
}

/* Error */
.error-alert {
  margin: 0;
}

/* Parts section */
.parts-section {
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  overflow: hidden;
}

.parts-header {
  background: var(--surface-raised, #f9fafb);
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}

.parts-table {
  max-height: 240px;
  overflow-y: auto;
}

.part-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  font-size: 13px;
}

.part-row:last-child {
  border-bottom: none;
}

.part-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 8px;
}

.part-status {
  flex-shrink: 0;
}

/* Colors */
.text-success { color: #67C23A; }
.text-danger { color: #F56C6C; }
.text-muted { color: #999; }
.text-accent { color: #409EFF; }

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Empty */
.empty-state {
  text-align: center;
  padding: 24px;
  font-size: 14px;
}

/* Footer */
.footer-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.prose {
  max-width: none;
}
</style>