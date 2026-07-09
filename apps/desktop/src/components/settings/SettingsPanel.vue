<script setup lang="ts">
import { useI18n } from "@/i18n/index";
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useKBStore } from "@/stores/kbStore";
import { testEmbedding, testLLM, testVLM, testRerank, cleanOrphans, checkLlamaStatus } from "@/services/pythonClient";
import { getMcpConfigJson, configureClaudeMCP, clearAllKBs, exportKBs, importKBs } from "@/services/tauriBridge";
import type { AppSettings } from "@/types";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Settings,
  FolderOpen,
  RotateCcw,
  Terminal,
  Copy,
  Check,
  Trash2,
  Download,
  Upload,
  Loader2,
  Wifi,
  WifiOff,
  FlaskConical,
  AlertTriangle,
  RefreshCw,
} from "lucide-vue-next";

const { t } = useI18n();
const store = useSettingsStore();
const kbStore = useKBStore();

// ── Local reactive copy ──
const local = ref<AppSettings>({ ...store.settings });
const saveStatus = ref<"saved" | "saving" | "idle">("idle");
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ── Active tab ──
const activeTab = ref("general");

// ── Test connection states ──
const embeddingTesting = ref(false);
const embeddingTestResult = ref<{ ok: boolean; msg: string } | null>(null);
const llmTesting = ref(false);
const llmTestResult = ref<{ ok: boolean; msg: string } | null>(null);
const vlmTesting = ref(false);
const vlmTestResult = ref<{ ok: boolean; msg: string } | null>(null);
const rerankTesting = ref(false);
const rerankTestResult = ref<{ ok: boolean; msg: string } | null>(null);

// ── Local model status polling ──
const embeddingLocalStatus = ref<"running" | "starting" | "stopped">("stopped");
const rerankLocalStatus = ref<"running" | "starting" | "stopped">("stopped");
let localStatusTimer: ReturnType<typeof setInterval> | null = null;

function startLocalStatusPolling() {
  if (localStatusTimer) return;
  const poll = async () => {
    try {
      const s: any = await checkLlamaStatus();
      const embInfo = s.embedding || s;
      const rnkInfo = s.rerank || s;
      if (embInfo.running) embeddingLocalStatus.value = "running";
      else if (embInfo.starting) embeddingLocalStatus.value = "starting";
      else embeddingLocalStatus.value = "stopped";
      if (rnkInfo.running) rerankLocalStatus.value = "running";
      else if (rnkInfo.starting) rerankLocalStatus.value = "starting";
      else rerankLocalStatus.value = "stopped";
    } catch {
      embeddingLocalStatus.value = "stopped";
      rerankLocalStatus.value = "stopped";
    }
  };
  poll();
  localStatusTimer = setInterval(poll, 3000);
}

function stopLocalStatusPolling() {
  if (localStatusTimer) {
    clearInterval(localStatusTimer);
    localStatusTimer = null;
  }
}

// ── MCP ──
const mcpConfigText = ref("");
const mcpCopied = ref(false);
const mcpConfiguring = ref(false);
const mcpResult = ref<{ success: boolean; message: string } | null>(null);

// ── Clean orphans ──
const cleaningOrphans = ref(false);
const orphansResult = ref<string | null>(null);

// ── Clear all KBs ──
const clearingAll = ref(false);
const clearResult = ref<string | null>(null);
const showClearDialog = ref(false);

// ── KB Export / Import ──
const selectedKBs = ref<Set<string>>(new Set());
const exporting = ref(false);
const importing = ref(false);
const dataResult = ref<string | null>(null);

// ── Config Export / Import ──
const configResult = ref<string | null>(null);

// ── Debounced save ──
function debouncedSave() {
  saveStatus.value = "saving";
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await store.saveSettings(local.value);
      saveStatus.value = "saved";
    } catch {
      saveStatus.value = "idle";
    }
    setTimeout(() => {
      if (saveStatus.value === "saved") saveStatus.value = "idle";
    }, 2000);
  }, 600);
}

// Deep watch all settings fields
watch(local, debouncedSave, { deep: true });

// ── Load ──
onMounted(async () => {
  await store.loadSettings();
  local.value = { ...store.settings };
  loadMcpConfig();
  await kbStore.loadKBs();
  startLocalStatusPolling();
});

onUnmounted(() => {
  stopLocalStatusPolling();
});

function loadMcpConfig() {
  getMcpConfigJson()
    .then((text) => { mcpConfigText.value = text; })
    .catch(() => { mcpConfigText.value = "{}"; });
}

// ── Test connections ──
async function testEmbeddingConnection() {
  embeddingTesting.value = true;
  embeddingTestResult.value = null;
  try {
    const useLocal = local.value.use_local_embedding;
    const base = useLocal
      ? `http://127.0.0.1:${local.value.llama_port || 8081}`
      : local.value.embedding_api_base;
    const key = useLocal ? "local" : local.value.embedding_api_key;
    const model = useLocal
      ? (local.value.local_embedding_model || "local")
          .replace(/\.gguf$/i, "")
          .split(/[/\\]/)
          .pop() || "local"
      : local.value.embedding_model;
    const res = await testEmbedding({ api_base: base, api_key: key, model });
    embeddingTestResult.value = {
      ok: res.valid,
      msg: res.valid
        ? `Connected (dim: ${res.dimension ?? "?"})`
        : res.status || "Failed",
    };
  } catch (e: any) {
    embeddingTestResult.value = { ok: false, msg: e?.message ?? String(e) };
  } finally {
    embeddingTesting.value = false;
  }
}

async function testRerankConnection() {
  rerankTesting.value = true;
  rerankTestResult.value = null;
  try {
    const useLocal = local.value.use_local_rerank;
    const base = useLocal
      ? `http://127.0.0.1:${(local.value.llama_port || 8081) + 1}`
      : local.value.rerank_api_base;
    const key = useLocal ? "local" : local.value.rerank_api_key;
    const model = useLocal
      ? (local.value.local_rerank_model || "local")
          .replace(/\.gguf$/i, "")
          .split(/[/\\]/)
          .pop() || "local"
      : local.value.rerank_model;
    const res = await testRerank({ api_base: base, api_key: key, model });
    rerankTestResult.value = {
      ok: res.valid,
      msg: res.valid ? "Connected" : res.status || "Failed",
    };
  } catch (e: any) {
    rerankTestResult.value = { ok: false, msg: e?.message ?? String(e) };
  } finally {
    rerankTesting.value = false;
  }
}

async function testLlmConnection() {
  llmTesting.value = true;
  llmTestResult.value = null;
  try {
    const res = await testLLM({
      api_base: local.value.llm_api_base,
      api_key: local.value.llm_api_key,
      model: local.value.llm_model,
    });
    llmTestResult.value = {
      ok: res.valid,
      msg: res.valid ? "Connected" : res.status || "Failed",
    };
  } catch (e: any) {
    llmTestResult.value = { ok: false, msg: e?.message ?? String(e) };
  } finally {
    llmTesting.value = false;
  }
}

async function testVlmConnection() {
  vlmTesting.value = true;
  vlmTestResult.value = null;
  try {
    const res = await testVLM({
      api_base: local.value.vlm_api_base || local.value.llm_api_base,
      api_key: local.value.vlm_api_key || local.value.llm_api_key,
      model: local.value.vlm_model || local.value.llm_model,
    });
    vlmTestResult.value = {
      ok: res.valid,
      msg: res.valid ? "Connected" : res.status || "Failed",
    };
  } catch (e: any) {
    vlmTestResult.value = { ok: false, msg: e?.message ?? String(e) };
  } finally {
    vlmTesting.value = false;
  }
}

// ── MCP ──
async function copyMcpConfig() {
  try {
    await navigator.clipboard.writeText(mcpConfigText.value);
    mcpCopied.value = true;
    setTimeout(() => { mcpCopied.value = false; }, 2000);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = mcpConfigText.value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    mcpCopied.value = true;
    setTimeout(() => { mcpCopied.value = false; }, 2000);
  }
}

async function configureMcp() {
  mcpConfiguring.value = true;
  mcpResult.value = null;
  try {
    const res = await configureClaudeMCP();
    mcpResult.value = res;
    loadMcpConfig();
  } catch (e: any) {
    mcpResult.value = { success: false, message: `Error: ${e?.message ?? String(e)}` };
  } finally {
    mcpConfiguring.value = false;
  }
}

// ── Clean orphans ──
async function handleCleanOrphans() {
  cleaningOrphans.value = true;
  orphansResult.value = null;
  try {
    const res = await cleanOrphans();
    orphansResult.value = res.cleaned > 0
      ? `Cleaned ${res.cleaned} orphan item(s).`
      : "No orphan data found.";
  } catch (e: any) {
    orphansResult.value = `Error: ${e?.message ?? String(e)}`;
  } finally {
    cleaningOrphans.value = false;
  }
}

// ── Clear all KBs ──
async function handleClearAll() {
  clearingAll.value = true;
  showClearDialog.value = false;
  try {
    const count = await clearAllKBs();
    clearResult.value = `Cleared ${count} KB(s).`;
    await kbStore.loadKBs();
    setTimeout(() => { clearResult.value = null; }, 4000);
  } catch (e: any) {
    clearResult.value = `Error: ${e?.message ?? String(e)}`;
    setTimeout(() => { clearResult.value = null; }, 4000);
  }
  clearingAll.value = false;
}

// ── KB Export / Import ──
function toggleSelectKB(id: string) {
  const next = new Set(selectedKBs.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedKBs.value = next;
}
function selectAllKBs() {
  selectedKBs.value = new Set(kbStore.knowledgeBases.map((k) => k.id));
}
function deselectAllKBs() {
  selectedKBs.value = new Set();
}

async function handleExportKBs() {
  if (selectedKBs.value.size === 0) return;
  exporting.value = true;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    let dn: string;
    if (selectedKBs.value.size === 1) {
      const kb = kbStore.knowledgeBases.find((k) => k.id === [...selectedKBs.value][0]);
      dn = `${(kb?.name || "kb").replace(/[\\/:*?"<>|]/g, "-")}.zip`;
    } else {
      dn = `kbs-${selectedKBs.value.size}-${new Date().toISOString().slice(0, 10)}.zip`;
    }
    const path = await save({ filters: [{ name: "ZIP", extensions: ["zip"] }], defaultPath: dn });
    if (path) {
      await exportKBs([...selectedKBs.value], path);
      dataResult.value = `Exported ${selectedKBs.value.size} KB(s).`;
      setTimeout(() => { dataResult.value = null; }, 4000);
    }
  } catch (e: any) {
    dataResult.value = `Error: ${e?.message ?? String(e)}`;
    setTimeout(() => { dataResult.value = null; }, 4000);
  }
  exporting.value = false;
}

async function handleImportKBs() {
  importing.value = true;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ filters: [{ name: "ZIP", extensions: ["zip"] }], multiple: false });
    if (sel) {
      const count = await importKBs(sel as string);
      await kbStore.loadKBs();
      dataResult.value = `Imported ${count} KB(s).`;
      setTimeout(() => { dataResult.value = null; }, 4000);
    }
  } catch (e: any) {
    dataResult.value = `Error: ${e?.message ?? String(e)}`;
    setTimeout(() => { dataResult.value = null; }, 4000);
  }
  importing.value = false;
}

// ── Export / Import settings JSON ──
async function exportSettingsJson() {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const p = await save({ filters: [{ name: "JSON", extensions: ["json"] }], defaultPath: "settings.json" });
    if (!p) return;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(p, JSON.stringify(local.value, null, 2));
    configResult.value = "Settings exported.";
    setTimeout(() => { configResult.value = null; }, 3000);
  } catch (e: any) {
    configResult.value = `Error: ${e?.message ?? String(e)}`;
    setTimeout(() => { configResult.value = null; }, 4000);
  }
}

async function importSettingsJson() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ filters: [{ name: "JSON", extensions: ["json"] }], multiple: false });
    if (!sel) return;
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const c = JSON.parse(await readTextFile(sel as string));
    if (c && typeof c === "object") Object.assign(local.value, c);
    configResult.value = "Settings imported.";
    setTimeout(() => { configResult.value = null; }, 3000);
  } catch (e: any) {
    configResult.value = `Error: ${e?.message ?? String(e)}`;
    setTimeout(() => { configResult.value = null; }, 4000);
  }
}

// ── Browse for data_dir ──
async function browseDataDir() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const d = await open({ directory: true });
    if (d) local.value.data_dir = d as string;
  } catch { /* ignore */ }
}

// ── Browse for local model files ──
async function browseGGUF(field: "local_embedding_model" | "local_rerank_model") {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const f = await open({ filters: [{ name: "GGUF", extensions: ["gguf"] }] });
    if (f) local.value[field] = f as string;
  } catch { /* ignore */ }
}
</script>

<template>
  <div class="settings-panel">
    <!-- Sticky header -->
    <div class="settings-header">
      <div class="flex items-center gap-2">
        <Settings :size="20" />
        <h2>{{ t("settings.title") }}</h2>
      </div>
      <div class="flex items-center gap-2">
        <el-tag v-if="saveStatus === 'saved'" type="success" size="small" effect="plain">{{ t("settings.saved") }}</el-tag>
        <el-tag v-else-if="saveStatus === 'saving'" type="info" size="small" effect="plain">{{ t("settings.testing") }}</el-tag>
      </div>
    </div>

    <el-tabs v-model="activeTab" class="settings-tabs" tab-position="top">
      <!-- ═══════ General ═══════ -->
      <el-tab-pane :label="t('settings.navGeneral')" name="general">
        <div class="tab-body">
          <!-- Data Directory -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.dataDir") }}</h3>
            <div class="field-row">
              <el-input
                v-model="local.data_dir"
                :placeholder="t('settings.dataDir')"
                size="small"
                style="flex: 1"
              />
              <el-button size="small" @click="browseDataDir">
                <FolderOpen :size="14" />
              </el-button>
              <el-button size="small" :disabled="!local.data_dir" @click="local.data_dir = ''">
                <RotateCcw :size="14" />
              </el-button>
            </div>
            <div class="field-hint">{{ t("settings.dataDirHint") }}</div>
          </div>

          <!-- MinerU -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.mineru") }}</h3>
            <div class="field-row">
              <div class="field-label">{{ t("settings.mineruToken") }}</div>
              <el-input
                v-model="local.mineru_token"
                type="password"
                show-password
                :placeholder="t('settings.mineruToken')"
                size="small"
                style="flex: 1"
              />
            </div>
            <div class="field-hint">
              {{ t("settings.mineruHint") }}
              <a href="https://mineru.net/apiManage/docs" target="_blank" class="link">MinerU API</a>.
            </div>
          </div>

          <!-- Python Backend -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.python") }}</h3>
            <div class="field-row">
              <div class="field-label">{{ t("settings.port") }}</div>
              <el-input-number v-model="local.python_port" :min="1024" :max="65535" size="small" />
            </div>
            <div class="field-row">
              <div class="field-label">Status</div>
              <el-tag :type="store.pythonRunning ? 'success' : 'danger'" size="small" effect="dark">
                <span class="status-row-inline">
                  <Wifi v-if="store.pythonRunning" :size="12" />
                  <WifiOff v-else :size="12" />
                  {{ store.pythonRunning ? t("settings.running") : t("settings.stopped") }}
                </span>
              </el-tag>
            </div>
            <div v-if="store.pythonUrl" class="field-row">
              <div class="field-label">URL</div>
              <code class="url-display">{{ store.pythonUrl }}</code>
            </div>
            <div v-if="store.pythonError" class="field-row">
              <el-alert :title="store.pythonError" type="error" show-icon :closable="false" />
            </div>
            <div class="field-row">
              <el-button
                size="small"
                type="primary"
                :disabled="store.pythonRunning"
                @click="store.startPython()"
              >
                {{ t("settings.startBackend") }}
              </el-button>
              <el-button
                size="small"
                type="warning"
                plain
                :disabled="!store.pythonRunning"
                @click="store.restartPython()"
              >
                {{ t("settings.restartBackend") }}
              </el-button>
            </div>
          </div>

          <!-- Claude MCP -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.claudeMCP") }}</h3>
            <div class="field-desc">{{ t("settings.claudeMCPDesc") }}</div>
            <div class="field-row">
              <el-button
                size="small"
                type="primary"
                :loading="mcpConfiguring"
                @click="configureMcp"
              >
                {{ mcpConfiguring ? t("settings.testing") : t("settings.configureClaude") }}
              </el-button>
              <el-button size="small" plain @click="copyMcpConfig">
                <Copy v-if="!mcpCopied" :size="14" style="margin-right: 4px" />
                <Check v-else :size="14" style="margin-right: 4px; color: var(--accent-color)" />
                {{ mcpCopied ? t("settings.saved") : t("settings.copyMCPConfig") }}
              </el-button>
            </div>
            <div v-if="mcpResult" class="field-row">
              <el-alert
                :title="mcpResult.message"
                :type="mcpResult.success ? 'success' : 'error'"
                :closable="false"
                show-icon
              />
            </div>
            <div class="field-row">
              <el-input
                :model-value="mcpConfigText"
                type="textarea"
                :rows="6"
                readonly
                size="small"
              />
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- ═══════ Models ═══════ -->
      <el-tab-pane :label="t('settings.navModels')" name="models">
        <div class="tab-body">
          <!-- Embedding -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.embedding") }}</h3>
            <div class="field-row">
              <div class="field-label">{{ t("settings.useLocal") }}</div>
              <el-switch v-model="local.use_local_embedding" size="small" />
            </div>

            <template v-if="local.use_local_embedding">
              <div class="local-model-box">
                <div class="status-row">
                  <span
                    class="status-dot"
                    :class="{
                      'status-green': embeddingLocalStatus === 'running',
                      'status-yellow': embeddingLocalStatus === 'starting',
                      'status-gray': embeddingLocalStatus === 'stopped',
                    }"
                  />
                  <span class="status-text">
                    {{ embeddingLocalStatus === "running" ? t("settings.llamaRunning") : embeddingLocalStatus === "starting" ? t("settings.llamaStarting") : t("settings.llamaStopped") }}
                  </span>
                </div>
                <div class="field-row">
                  <div class="field-label">{{ t("settings.modelFile") }}</div>
                  <div class="field-input-group">
                    <el-input
                      v-model="local.local_embedding_model"
                      :placeholder="t('settings.modelFile')"
                      size="small"
                      style="flex: 1"
                    />
                    <el-button size="small" @click="browseGGUF('local_embedding_model')">
                      <FolderOpen :size="14" />
                    </el-button>
                  </div>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="field-row">
                <div class="field-label">{{ t("settings.apiBase") }}</div>
                <el-input
                  v-model="local.embedding_api_base"
                  placeholder="https://api.openai.com/v1"
                  size="small"
                  style="flex: 1"
                />
              </div>
              <div class="field-row">
                <div class="field-label">{{ t("settings.apiKey") }}</div>
                <el-input
                  v-model="local.embedding_api_key"
                  type="password"
                  show-password
                  placeholder="sk-..."
                  size="small"
                  style="flex: 1"
                />
              </div>
              <div class="field-row">
                <div class="field-label">{{ t("settings.model") }}</div>
                <el-input
                  v-model="local.embedding_model"
                  placeholder="text-embedding-3-small"
                  size="small"
                  style="flex: 1"
                />
              </div>
            </template>

            <div class="field-row">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="embeddingTesting"
                :disabled="!store.pythonRunning"
                @click="testEmbeddingConnection"
              >
                {{ embeddingTesting ? t("settings.testing") : t("settings.testConnection") }}
              </el-button>
              <el-tag
                v-if="embeddingTestResult"
                :type="embeddingTestResult.ok ? 'success' : 'danger'"
                size="small"
                effect="plain"
              >
                {{ embeddingTestResult.msg }}
              </el-tag>
            </div>
          </div>

          <!-- Rerank -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.rerank") }}</h3>
            <div class="field-row">
              <div class="field-label">{{ t("settings.useLocal") }}</div>
              <el-switch v-model="local.use_local_rerank" size="small" />
            </div>

            <template v-if="local.use_local_rerank">
              <div class="local-model-box">
                <div class="status-row">
                  <span
                    class="status-dot"
                    :class="{
                      'status-green': rerankLocalStatus === 'running',
                      'status-yellow': rerankLocalStatus === 'starting',
                      'status-gray': rerankLocalStatus === 'stopped',
                    }"
                  />
                  <span class="status-text">
                    {{ rerankLocalStatus === "running" ? t("settings.llamaRunning") : rerankLocalStatus === "starting" ? t("settings.llamaStarting") : t("settings.llamaStopped") }}
                  </span>
                </div>
                <div class="field-row">
                  <div class="field-label">{{ t("settings.modelFile") }}</div>
                  <div class="field-input-group">
                    <el-input
                      v-model="local.local_rerank_model"
                      :placeholder="t('settings.modelFile')"
                      size="small"
                      style="flex: 1"
                    />
                    <el-button size="small" @click="browseGGUF('local_rerank_model')">
                      <FolderOpen :size="14" />
                    </el-button>
                  </div>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="field-row">
                <div class="field-label">{{ t("settings.apiBase") }}</div>
                <el-input
                  v-model="local.rerank_api_base"
                  placeholder="https://api.jina.ai/v1"
                  size="small"
                  style="flex: 1"
                />
              </div>
              <div class="field-row">
                <div class="field-label">{{ t("settings.apiKey") }}</div>
                <el-input
                  v-model="local.rerank_api_key"
                  type="password"
                  show-password
                  placeholder="Enter API key"
                  size="small"
                  style="flex: 1"
                />
              </div>
              <div class="field-row">
                <div class="field-label">{{ t("settings.model") }}</div>
                <el-input
                  v-model="local.rerank_model"
                  placeholder="jina-reranker-v2-base-multilingual"
                  size="small"
                  style="flex: 1"
                />
              </div>
            </template>

            <div class="field-row">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="rerankTesting"
                :disabled="!store.pythonRunning"
                @click="testRerankConnection"
              >
                {{ rerankTesting ? t("settings.testing") : t("settings.testConnection") }}
              </el-button>
              <el-tag
                v-if="rerankTestResult"
                :type="rerankTestResult.ok ? 'success' : 'danger'"
                size="small"
                effect="plain"
              >
                {{ rerankTestResult.msg }}
              </el-tag>
            </div>
          </div>

          <!-- LLM -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.llm") }}</h3>
            <div class="field-row">
              <div class="field-label">{{ t("settings.apiBase") }}</div>
              <el-input
                v-model="local.llm_api_base"
                placeholder="https://api.openai.com/v1"
                size="small"
                style="flex: 1"
              />
            </div>
            <div class="field-row">
              <div class="field-label">{{ t("settings.apiKey") }}</div>
              <el-input
                v-model="local.llm_api_key"
                type="password"
                show-password
                placeholder="sk-..."
                size="small"
                style="flex: 1"
              />
            </div>
            <div class="field-row">
              <div class="field-label">{{ t("settings.model") }}</div>
              <el-input
                v-model="local.llm_model"
                placeholder="gpt-4o-mini"
                size="small"
                style="flex: 1"
              />
            </div>

            <div class="field-row">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="llmTesting"
                :disabled="!local.llm_api_base || !local.llm_model"
                @click="testLlmConnection"
              >
                {{ llmTesting ? t("settings.testing") : t("settings.testConnection") }}
              </el-button>
              <el-tag
                v-if="llmTestResult"
                :type="llmTestResult.ok ? 'success' : 'danger'"
                size="small"
                effect="plain"
              >
                {{ llmTestResult.msg }}
              </el-tag>
            </div>
          </div>

          <!-- VLM -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.vlm") }}</h3>
            <div class="field-desc">{{ t("settings.vlmHint") }}</div>
            <div class="field-row">
              <div class="field-label">{{ t("settings.apiBase") }}</div>
              <el-input
                v-model="local.vlm_api_base"
                :placeholder="t('settings.apiBase')"
                size="small"
                style="flex: 1"
              />
            </div>
            <div class="field-row">
              <div class="field-label">{{ t("settings.apiKey") }}</div>
              <el-input
                v-model="local.vlm_api_key"
                type="password"
                show-password
                :placeholder="t('settings.apiKey')"
                size="small"
                style="flex: 1"
              />
            </div>
            <div class="field-row">
              <div class="field-label">{{ t("settings.model") }}</div>
              <el-input
                v-model="local.vlm_model"
                :placeholder="t('settings.model')"
                size="small"
                style="flex: 1"
              />
            </div>

            <div class="field-row">
              <div class="field-label">{{ t("settings.vlmEnabled") }}</div>
              <el-switch v-model="local.vlm_enabled" size="small" />
            </div>
            <div class="field-hint">{{ t("settings.vlmEnabledHint") }}</div>

            <div class="field-row">
              <div class="field-label">{{ t("settings.vlmConcurrency") }}</div>
              <el-input-number v-model="local.vlm_concurrency" :min="1" :max="20" size="small" />
            </div>
            <div class="field-hint">{{ t("settings.vlmConcurrencyHint") }}</div>

            <div class="field-row">
              <div class="field-label">{{ t("settings.extractMultimodal") }}</div>
              <el-switch v-model="local.extract_multimodal" size="small" />
            </div>
            <div class="field-hint">{{ t("settings.extractMultimodalHint") }}</div>

            <div class="field-row">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="vlmTesting"
                :disabled="!local.vlm_api_base && !local.llm_api_base"
                @click="testVlmConnection"
              >
                {{ vlmTesting ? t("settings.testing") : t("settings.testConnection") }}
              </el-button>
              <el-tag
                v-if="vlmTestResult"
                :type="vlmTestResult.ok ? 'success' : 'danger'"
                size="small"
                effect="plain"
              >
                {{ vlmTestResult.msg }}
              </el-tag>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- ═══════ Chat & Tools ═══════ -->
      <el-tab-pane :label="t('settings.navChat')" name="chat">
        <div class="tab-body">
          <!-- Tool Limits -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.toolLimits") }}</h3>
            <div class="num-grid">
              <div class="field-row-vert">
                <div class="field-label">{{ t("settings.maxToolRounds") }}</div>
                <el-input-number v-model="local.max_tool_rounds" :min="1" :max="500" size="small" />
              </div>
              <div class="field-row-vert">
                <div class="field-label">{{ t("settings.maxHistoryMessages") }}</div>
                <el-input-number v-model="local.max_history_messages" :min="1" :max="500" size="small" />
              </div>
              <div class="field-row-vert">
                <div class="field-label">{{ t("settings.maxSearchResultChars") }}</div>
                <el-input-number v-model="local.max_search_result_chars" :min="100" :max="50000" size="small" />
              </div>
              <div class="field-row-vert">
                <div class="field-label">{{ t("settings.maxDocumentChars") }}</div>
                <el-input-number v-model="local.max_document_chars" :min="100" :max="100000" size="small" />
              </div>
              <div class="field-row-vert">
                <div class="field-label">{{ t("settings.maxChunkChars") }}</div>
                <el-input-number v-model="local.max_chunk_chars" :min="100" :max="10000" size="small" />
              </div>
            </div>
          </div>

          <!-- Web Search -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.webSearch") }}</h3>
            <div class="field-desc">{{ t("settings.webSearchDesc") }}</div>
            <div class="field-row">
              <div class="field-label">{{ t("settings.webSearchProvider") }}</div>
              <el-select v-model="local.web_search_provider" size="small" style="width: 200px">
                <el-option label="DuckDuckGo (free)" value="duckduckgo" />
                <el-option label="Tavily" value="tavily" />
                <el-option label="SearXNG" value="searxng" />
              </el-select>
            </div>

            <template v-if="local.web_search_provider === 'duckduckgo'">
              <div class="field-hint">{{ t("settings.webSearchDdgDesc") }}</div>
            </template>
            <template v-else-if="local.web_search_provider === 'tavily'">
              <div class="field-row">
                <div class="field-label">{{ t("settings.tavilyApiKey") }}</div>
                <el-input
                  v-model="local.tavily_api_key"
                  type="password"
                  show-password
                  placeholder="tvly-..."
                  size="small"
                  style="flex: 1"
                />
              </div>
              <div class="field-hint">
                <a href="https://tavily.com" target="_blank" class="link">Tavily</a> -- free tier: 1000 searches/month
              </div>
            </template>
            <template v-else>
              <div class="field-row">
                <div class="field-label">{{ t("settings.searxngBaseUrl") }}</div>
                <el-input
                  v-model="local.searxng_base_url"
                  placeholder="http://localhost:8080"
                  size="small"
                  style="flex: 1"
                />
              </div>
            </template>

            <div class="field-row">
              <div class="field-label">{{ t("settings.webSearchMaxResults") }}</div>
              <el-input-number v-model="local.web_search_max_results" :min="1" :max="10" size="small" />
            </div>
          </div>

          <!-- Chunking -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.chunking") }}</h3>
            <div class="field-row">
              <div class="field-label">{{ t("settings.strategy") }}</div>
              <el-select v-model="local.chunk_strategy" size="small" style="width: 220px">
                <el-option :label="t('settings.recursive')" value="recursive" />
                <el-option :label="t('settings.semantic')" value="semantic" />
                <el-option :label="t('settings.fixed')" value="fixed" />
              </el-select>
            </div>
            <div class="field-row">
              <div class="field-label">{{ t("settings.chunkSize") }}</div>
              <el-input-number v-model="local.chunk_size" :min="64" :max="4096" :step="64" size="small" />
            </div>
            <div class="field-row">
              <div class="field-label">{{ t("settings.chunkOverlap") }}</div>
              <el-input-number v-model="local.chunk_overlap" :min="0" :max="512" :step="16" size="small" />
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- ═══════ Data ═══════ -->
      <el-tab-pane :label="t('settings.navData')" name="data">
        <div class="tab-body">
          <!-- Export / Import KBs -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.export") }}</h3>
            <div class="field-desc">{{ t("settings.exportDesc") }}</div>

            <div v-if="kbStore.knowledgeBases.length > 0">
              <div class="field-row" style="margin-bottom: 4px">
                <el-button size="small" text type="primary" @click="selectAllKBs">{{ t("settings.selectAll") }}</el-button>
                <el-button size="small" text type="primary" @click="deselectAllKBs">{{ t("settings.deselectAll") }}</el-button>
              </div>
              <div class="kb-select-list">
                <label
                  v-for="kb in kbStore.knowledgeBases"
                  :key="kb.id"
                  class="kb-select-item"
                >
                  <el-checkbox
                    :model-value="selectedKBs.has(kb.id)"
                    @change="toggleSelectKB(kb.id)"
                  />
                  <span class="kb-select-name">{{ kb.name }}</span>
                  <span class="kb-select-count">{{ kb.document_count }}</span>
                </label>
              </div>
            </div>

            <div class="field-row">
              <el-button
                size="small"
                type="primary"
                :loading="exporting"
                :disabled="selectedKBs.size === 0"
                @click="handleExportKBs"
              >
                <Download :size="14" style="margin-right: 4px" />
                {{ exporting ? t("settings.exporting") : `${t("settings.exportBtn")} (${selectedKBs.size})` }}
              </el-button>
            </div>

            <div class="section-divider" />
            <div class="field-desc" style="margin-top: 4px">{{ t("settings.importDesc") }}</div>
            <div class="field-row">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="importing"
                @click="handleImportKBs"
              >
                <Upload :size="14" style="margin-right: 4px" />
                {{ importing ? t("settings.importing") : t("settings.importBtn") }}
              </el-button>
            </div>

            <div v-if="dataResult" class="field-row">
              <el-tag
                :type="dataResult.startsWith('Error') ? 'danger' : 'success'"
                size="small"
                effect="plain"
              >
                {{ dataResult }}
              </el-tag>
            </div>
          </div>

          <!-- Config I/O -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.configIO") }}</h3>
            <div class="field-desc">{{ t("settings.configIODesc") }}</div>
            <div class="field-row">
              <el-button size="small" type="primary" plain @click="exportSettingsJson">
                <Download :size="14" style="margin-right: 4px" />
                {{ t("settings.exportConfig") }}
              </el-button>
              <el-button size="small" type="primary" plain @click="importSettingsJson">
                <Upload :size="14" style="margin-right: 4px" />
                {{ t("settings.importConfig") }}
              </el-button>
            </div>
            <div v-if="configResult" class="field-row">
              <el-tag
                :type="configResult.startsWith('Error') ? 'danger' : 'success'"
                size="small"
                effect="plain"
              >
                {{ configResult }}
              </el-tag>
            </div>
          </div>

          <!-- Cleanup -->
          <div class="section-card">
            <h3 class="section-title">{{ t("settings.clearAll") }}</h3>
            <div class="field-row">
              <el-button
                size="small"
                type="danger"
                plain
                :loading="cleaningOrphans"
                :disabled="!store.pythonRunning"
                @click="handleCleanOrphans"
              >
                <Trash2 :size="14" style="margin-right: 4px" />
                {{ cleaningOrphans ? t("settings.cleaning") : t("settings.cleanOrphans") }}
              </el-button>
              <el-button
                size="small"
                type="danger"
                :loading="clearingAll"
                @click="showClearDialog = true"
              >
                <Trash2 :size="14" style="margin-right: 4px" />
                {{ clearingAll ? t("settings.clearing") : t("settings.clearAllBtn") }}
              </el-button>
            </div>
            <div v-if="orphansResult" class="field-row">
              <el-tag
                :type="orphansResult.startsWith('Error') ? 'danger' : 'success'"
                size="small"
                effect="plain"
              >
                {{ orphansResult }}
              </el-tag>
            </div>
            <div v-if="clearResult" class="field-row">
              <el-tag
                :type="clearResult.startsWith('Error') ? 'danger' : 'success'"
                size="small"
                effect="plain"
              >
                {{ clearResult }}
              </el-tag>
            </div>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- Clear All KBs confirmation dialog -->
    <el-dialog
      v-model="showClearDialog"
      :title="t('settings.clearAll')"
      width="450px"
      :close-on-click-modal="false"
    >
      <p style="margin: 0; line-height: 1.6">
        {{ t("settings.clearAllConfirm") }}
      </p>
      <template #footer>
        <el-button size="small" @click="showClearDialog = false">{{ t("kb.cancel") }}</el-button>
        <el-button size="small" type="danger" @click="handleClearAll">{{ t("settings.clearAllConfirmBtn") }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  gap: 0;
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 0 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-color);
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--surface);
}

.settings-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.settings-tabs {
  border: none;
  border-radius: var(--radius);
}

.tab-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 8px 4px;
}

.section-card {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: box-shadow 150ms ease, border-color 150ms ease;
}

.section-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  border-color: var(--accent-color);
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 8px;
  margin-bottom: 4px;
}

.field-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.field-row-vert {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-input-group {
  display: flex;
  gap: 4px;
  align-items: center;
  flex: 1;
}

.field-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-secondary);
  min-width: 120px;
  flex-shrink: 0;
}

.field-hint {
  font-size: 12px;
  color: var(--text-secondary);
  width: 100%;
  margin-top: -4px;
  line-height: 1.5;
}

.field-desc {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.link {
  color: var(--accent-color);
  text-decoration: underline;
}

.section-divider {
  border-top: 1px solid var(--border-color);
  padding-top: 4px;
}

.num-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-green {
  background: #22c55e;
}

.status-yellow {
  background: #eab308;
  animation: pulse 1.5s ease-in-out infinite;
}

.status-gray {
  background: var(--text-secondary);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}

.status-text {
  font-size: 12px;
  color: var(--text-secondary);
}

.status-row-inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.local-model-box {
  padding: 12px;
  background: var(--bg-primary);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.url-display {
  font-size: 12px;
  padding: 4px 8px;
  background: var(--bg-primary);
  border-radius: var(--radius);
  color: var(--text-primary);
}

.kb-select-list {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kb-select-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 120ms;
}

.kb-select-item:hover {
  background: var(--bg-primary);
}

.kb-select-name {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-select-count {
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

:deep(.el-dialog) {
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}
</style>
