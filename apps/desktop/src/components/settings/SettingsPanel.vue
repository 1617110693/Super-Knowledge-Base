<script setup lang="ts">
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

const store = useSettingsStore();
const kbStore = useKBStore();

// ── Local reactive copy ──
const local = ref<AppSettings>({ ...store.settings });
const saveStatus = ref<"saved" | "saving" | "idle">("idle");
let saveTimer: ReturnType<typeof setTimeout> | null = null;

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
      // The API may return per-model status or a flat object
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

// ── Collapse sections ──
const activeSections = ref<string[]>([
  "general", "mineru", "embedding", "rerank", "llm", "web-search",
  "vlm", "chunk", "python", "mcp", "export", "config-io", "cleanup",
]);

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

// ── Computed helpers ──
const sectionTitles = {
  general: "General",
  mineru: "MinerU Document Parsing",
  embedding: "Embedding Model",
  rerank: "Rerank Model",
  llm: "LLM for Chat",
  "web-search": "Web Search",
  vlm: "VLM for Image Description",
  chunk: "Chunking Configuration",
  python: "Python Backend",
  mcp: "Claude Code Integration",
  export: "Export / Import KBs",
  "config-io": "Settings Config",
  cleanup: "Data Cleanup",
} as const;

const sectionHints = computed(() => ({
  general: local.value.data_dir || "~/.super-knowledge-base",
  mineru: local.value.mineru_token ? "Token configured" : "",
  embedding: local.value.use_local_embedding ? "Local" : local.value.embedding_model,
  rerank: local.value.use_local_rerank ? "Local" : local.value.rerank_model,
  llm: local.value.llm_model,
  "web-search": local.value.web_search_provider || "duckduckgo",
  vlm: local.value.vlm_model || "VLM for image captioning",
  chunk: undefined,
  python: store.pythonRunning ? "Running" : "Stopped",
  mcp: undefined,
  export: `${selectedKBs.value.size} selected`,
  "config-io": undefined,
  cleanup: undefined,
}));
</script>

<template>
  <div class="settings-panel">
    <!-- Sticky header -->
    <div class="settings-header">
      <div class="flex items-center gap-2">
        <Settings :size="20" />
        <h2>Settings</h2>
      </div>
      <div class="flex items-center gap-2">
        <el-tag v-if="saveStatus === 'saved'" type="success" size="small" effect="plain">Saved</el-tag>
        <el-tag v-else-if="saveStatus === 'saving'" type="info" size="small" effect="plain">Saving...</el-tag>
      </div>
    </div>

    <el-collapse v-model="activeSections" class="settings-collapse">
      <!-- ═══════ General ═══════ -->
      <el-collapse-item name="general">
        <template #title>
          <div class="panel-title">
            <Settings :size="16" />
            <span>General</span>
            <span v-if="!activeSections.includes('general')" class="hint-text">{{ sectionHints.general }}</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-row">
            <div class="field-label">Data Directory</div>
            <div class="field-input-group">
              <el-input
                v-model="local.data_dir"
                placeholder="Default: ~/.super-knowledge-base"
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
          </div>
          <div class="field-hint">
            Where documents and indexes are stored. Restart required after changing.
          </div>

          <div class="field-row">
            <div class="field-label">Theme</div>
            <el-radio-group v-model="local.theme" size="small">
              <el-radio-button value="light">Light</el-radio-button>
              <el-radio-button value="dark">Dark</el-radio-button>
              <el-radio-button value="system">System</el-radio-button>
            </el-radio-group>
          </div>
        </div>
      </el-collapse-item>

      <!-- ═══════ MinerU ═══════ -->
      <el-collapse-item name="mineru">
        <template #title>
          <div class="panel-title">
            <Terminal :size="16" />
            <span>MinerU Document Parsing</span>
            <span v-if="!activeSections.includes('mineru')" class="hint-text">{{ sectionHints.mineru }}</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-row">
            <div class="field-label">MinerU Token</div>
            <el-input
              v-model="local.mineru_token"
              type="password"
              show-password
              placeholder="Enter MinerU API token"
              size="small"
              style="flex: 1"
            />
          </div>
          <div class="field-hint">
            Get your token from
            <a href="https://mineru.net/apiManage/docs" target="_blank" class="link">MinerU API</a>.
          </div>
        </div>
      </el-collapse-item>

      <!-- ═══════ Embedding ═══════ -->
      <el-collapse-item name="embedding">
        <template #title>
          <div class="panel-title">
            <FlaskConical :size="16" />
            <span>Embedding Model</span>
            <span v-if="!activeSections.includes('embedding')" class="hint-text">{{ sectionHints.embedding }}</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-row">
            <div class="field-label">Use Local Model</div>
            <el-switch v-model="local.use_local_embedding" size="small" />
          </div>

          <template v-if="local.use_local_embedding">
            <div class="local-model-box">
              <!-- Local status -->
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
                  {{
                    embeddingLocalStatus === "running"
                      ? "Running"
                      : embeddingLocalStatus === "starting"
                        ? "Starting..."
                        : "Stopped"
                  }}
                </span>
              </div>
              <div class="field-row">
                <div class="field-label">Model File</div>
                <div class="field-input-group">
                  <el-input
                    v-model="local.local_embedding_model"
                    placeholder="Qwen3-Embedding-0.6B-Q8_0.gguf"
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
              <div class="field-label">API Base URL</div>
              <el-input
                v-model="local.embedding_api_base"
                placeholder="https://api.openai.com/v1"
                size="small"
                style="flex: 1"
              />
            </div>
            <div class="field-row">
              <div class="field-label">API Key</div>
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
              <div class="field-label">Model</div>
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
              {{ embeddingTesting ? "Testing..." : "Test Connection" }}
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
      </el-collapse-item>

      <!-- ═══════ Rerank ═══════ -->
      <el-collapse-item name="rerank">
        <template #title>
          <div class="panel-title">
            <FlaskConical :size="16" />
            <span>Rerank Model</span>
            <span v-if="!activeSections.includes('rerank')" class="hint-text">{{ sectionHints.rerank }}</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-row">
            <div class="field-label">Use Local Model</div>
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
                  {{
                    rerankLocalStatus === "running"
                      ? "Running"
                      : rerankLocalStatus === "starting"
                        ? "Starting..."
                        : "Stopped"
                  }}
                </span>
              </div>
              <div class="field-row">
                <div class="field-label">Model File</div>
                <div class="field-input-group">
                  <el-input
                    v-model="local.local_rerank_model"
                    placeholder="qwen3-reranker-0.6b-q8_0.gguf"
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
              <div class="field-label">API Base URL</div>
              <el-input
                v-model="local.rerank_api_base"
                placeholder="https://api.jina.ai/v1"
                size="small"
                style="flex: 1"
              />
            </div>
            <div class="field-row">
              <div class="field-label">API Key</div>
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
              <div class="field-label">Model</div>
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
              {{ rerankTesting ? "Testing..." : "Test Connection" }}
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
      </el-collapse-item>

      <!-- ═══════ LLM ═══════ -->
      <el-collapse-item name="llm">
        <template #title>
          <div class="panel-title">
            <Terminal :size="16" />
            <span>LLM for Chat</span>
            <span v-if="!activeSections.includes('llm')" class="hint-text">{{ sectionHints.llm }}</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-row">
            <div class="field-label">API Base URL</div>
            <el-input
              v-model="local.llm_api_base"
              placeholder="https://api.openai.com/v1"
              size="small"
              style="flex: 1"
            />
          </div>
          <div class="field-row">
            <div class="field-label">API Key</div>
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
            <div class="field-label">Model</div>
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
              {{ llmTesting ? "Testing..." : "Test Connection" }}
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

          <div class="section-divider" />
          <div class="tool-limits-title">Tool Limits</div>
          <div class="num-grid">
            <div class="field-row-vert">
              <div class="field-label">Max Tool Rounds</div>
              <el-input-number v-model="local.max_tool_rounds" :min="1" :max="500" size="small" />
            </div>
            <div class="field-row-vert">
              <div class="field-label">Max History Messages</div>
              <el-input-number v-model="local.max_history_messages" :min="1" :max="500" size="small" />
            </div>
            <div class="field-row-vert">
              <div class="field-label">Max Search Result Chars</div>
              <el-input-number v-model="local.max_search_result_chars" :min="100" :max="50000" size="small" />
            </div>
            <div class="field-row-vert">
              <div class="field-label">Max Document Chars</div>
              <el-input-number v-model="local.max_document_chars" :min="100" :max="100000" size="small" />
            </div>
            <div class="field-row-vert">
              <div class="field-label">Max Chunk Chars</div>
              <el-input-number v-model="local.max_chunk_chars" :min="100" :max="10000" size="small" />
            </div>
          </div>
        </div>
      </el-collapse-item>

      <!-- ═══════ Web Search ═══════ -->
      <el-collapse-item name="web-search">
        <template #title>
          <div class="panel-title">
            <Terminal :size="16" />
            <span>Web Search</span>
            <span v-if="!activeSections.includes('web-search')" class="hint-text">{{ sectionHints["web-search"] }}</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-hint">
            Configure web search for the LLM to use when answering questions.
          </div>
          <div class="field-row">
            <div class="field-label">Provider</div>
            <el-select v-model="local.web_search_provider" size="small" style="width: 200px">
              <el-option label="DuckDuckGo (free)" value="duckduckgo" />
              <el-option label="Tavily" value="tavily" />
              <el-option label="SearXNG" value="searxng" />
            </el-select>
          </div>

          <template v-if="local.web_search_provider === 'duckduckgo'">
            <div class="field-hint">
              DuckDuckGo is free and requires no configuration.
            </div>
          </template>
          <template v-else-if="local.web_search_provider === 'tavily'">
            <div class="field-row">
              <div class="field-label">Tavily API Key</div>
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
              <div class="field-label">SearXNG Base URL</div>
              <el-input
                v-model="local.searxng_base_url"
                placeholder="http://localhost:8080"
                size="small"
                style="flex: 1"
              />
            </div>
          </template>

          <div class="field-row">
            <div class="field-label">Max Results</div>
            <el-input-number v-model="local.web_search_max_results" :min="1" :max="10" size="small" />
          </div>
        </div>
      </el-collapse-item>

      <!-- ═══════ VLM ═══════ -->
      <el-collapse-item name="vlm">
        <template #title>
          <div class="panel-title">
            <Terminal :size="16" />
            <span>VLM for Image Description</span>
            <span v-if="!activeSections.includes('vlm')" class="hint-text">{{ sectionHints.vlm }}</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-hint">
            Vision Language Model used to generate descriptions for images in documents.
          </div>
          <div class="field-row">
            <div class="field-label">API Base URL</div>
            <el-input
              v-model="local.vlm_api_base"
              placeholder="Same as LLM if empty"
              size="small"
              style="flex: 1"
            />
          </div>
          <div class="field-row">
            <div class="field-label">API Key</div>
            <el-input
              v-model="local.vlm_api_key"
              type="password"
              show-password
              placeholder="Same as LLM if empty"
              size="small"
              style="flex: 1"
            />
          </div>
          <div class="field-row">
            <div class="field-label">Model</div>
            <el-input
              v-model="local.vlm_model"
              placeholder="Same as LLM if empty"
              size="small"
              style="flex: 1"
            />
          </div>

          <div class="field-row">
            <div class="field-label">Enabled</div>
            <el-switch v-model="local.vlm_enabled" size="small" />
          </div>
          <div class="field-hint">
            Enable VLM-based image description during document parsing.
          </div>

          <div class="field-row">
            <div class="field-label">Concurrency</div>
            <el-input-number v-model="local.vlm_concurrency" :min="1" :max="20" size="small" />
          </div>
          <div class="field-hint">
            Number of concurrent VLM requests. Higher values are faster but may hit rate limits.
          </div>

          <div class="field-row">
            <div class="field-label">Extract Multimodal</div>
            <el-switch v-model="local.extract_multimodal" size="small" />
          </div>
          <div class="field-hint">
            Extract images, tables, and equations from documents. Requires VLM to be enabled.
          </div>

          <div class="field-row">
            <el-button
              size="small"
              type="primary"
              plain
              :loading="vlmTesting"
              :disabled="!local.vlm_api_base && !local.llm_api_base"
              @click="testVlmConnection"
            >
              {{ vlmTesting ? "Testing..." : "Test Connection" }}
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
      </el-collapse-item>

      <!-- ═══════ Chunking ═══════ -->
      <el-collapse-item name="chunk">
        <template #title>
          <div class="panel-title">
            <Terminal :size="16" />
            <span>Chunking Configuration</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-row">
            <div class="field-label">Strategy</div>
            <el-select v-model="local.chunk_strategy" size="small" style="width: 220px">
              <el-option label="Recursive (recommended)" value="recursive" />
              <el-option label="Semantic (sentence boundary)" value="semantic" />
              <el-option label="Fixed Size" value="fixed" />
            </el-select>
          </div>
          <div class="field-row">
            <div class="field-label">Chunk Size</div>
            <el-input-number v-model="local.chunk_size" :min="64" :max="4096" :step="64" size="small" />
          </div>
          <div class="field-row">
            <div class="field-label">Chunk Overlap</div>
            <el-input-number v-model="local.chunk_overlap" :min="0" :max="512" :step="16" size="small" />
          </div>
        </div>
      </el-collapse-item>

      <!-- ═══════ Python Backend ═══════ -->
      <el-collapse-item name="python">
        <template #title>
          <div class="panel-title">
            <Terminal :size="16" />
            <span>Python Backend</span>
            <span class="status-dot-inline" :class="store.pythonRunning ? 'status-green' : 'status-red'" />
            <span v-if="!activeSections.includes('python')" class="hint-text">{{ sectionHints.python }}</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-row">
            <div class="field-label">Status</div>
            <el-tag :type="store.pythonRunning ? 'success' : 'danger'" size="small" effect="dark">
              <span class="status-row-inline">
                <Wifi v-if="store.pythonRunning" :size="12" />
                <WifiOff v-else :size="12" />
                {{ store.pythonRunning ? "Running" : "Stopped" }}
              </span>
            </el-tag>
          </div>
          <div class="field-row">
            <div class="field-label">Port</div>
            <el-input-number v-model="local.python_port" :min="1024" :max="65535" size="small" />
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
              Start Backend
            </el-button>
            <el-button
              size="small"
              type="warning"
              plain
              :disabled="!store.pythonRunning"
              @click="store.restartPython()"
            >
              Restart Backend
            </el-button>
          </div>
        </div>
      </el-collapse-item>

      <!-- ═══════ Claude MCP ═══════ -->
      <el-collapse-item name="mcp">
        <template #title>
          <div class="panel-title">
            <Terminal :size="16" />
            <span>Claude Code Integration</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-desc">
            Auto-configure the MCP server for Claude Code. This writes the config to
            ~/.claude.json so Claude Code can search your knowledge bases.
          </div>
          <div class="field-row">
            <el-button
              size="small"
              type="primary"
              :loading="mcpConfiguring"
              @click="configureMcp"
            >
              {{ mcpConfiguring ? "Configuring..." : "Configure Claude Code MCP" }}
            </el-button>
            <el-button size="small" plain @click="copyMcpConfig">
              <Copy v-if="!mcpCopied" :size="14" style="margin-right: 4px" />
              <Check v-else :size="14" style="margin-right: 4px; color: var(--el-color-success)" />
              {{ mcpCopied ? "Copied" : "Copy MCP Config" }}
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
      </el-collapse-item>

      <!-- ═══════ Export / Import KBs ═══════ -->
      <el-collapse-item name="export">
        <template #title>
          <div class="panel-title">
            <Download :size="16" />
            <span>Export / Import KBs</span>
            <span v-if="!activeSections.includes('export')" class="hint-text">{{ sectionHints.export }}</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-desc">
            Export knowledge bases as ZIP files or import them from ZIP files.
          </div>

          <div v-if="kbStore.knowledgeBases.length > 0">
            <div class="field-row" style="margin-bottom: 4px">
              <el-button size="small" text type="primary" @click="selectAllKBs">Select All</el-button>
              <el-button size="small" text type="primary" @click="deselectAllKBs">Deselect All</el-button>
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
              {{ exporting ? "Exporting..." : `Export (${selectedKBs.size})` }}
            </el-button>
          </div>

          <div class="section-divider" />
          <div class="field-row">
            <el-button
              size="small"
              type="primary"
              plain
              :loading="importing"
              @click="handleImportKBs"
            >
              <Upload :size="14" style="margin-right: 4px" />
              {{ importing ? "Importing..." : "Import KBs" }}
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
      </el-collapse-item>

      <!-- ═══════ Settings Config ═══════ -->
      <el-collapse-item name="config-io">
        <template #title>
          <div class="panel-title">
            <Settings :size="16" />
            <span>Settings Config</span>
          </div>
        </template>
        <div class="section-body">
          <div class="field-desc">
            Export or import the full settings.json configuration file.
          </div>
          <div class="field-row">
            <el-button size="small" type="primary" plain @click="exportSettingsJson">
              <Download :size="14" style="margin-right: 4px" />
              Export Config
            </el-button>
            <el-button size="small" type="primary" plain @click="importSettingsJson">
              <Upload :size="14" style="margin-right: 4px" />
              Import Config
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
      </el-collapse-item>

      <!-- ═══════ Data Cleanup ═══════ -->
      <el-collapse-item name="cleanup">
        <template #title>
          <div class="panel-title">
            <Trash2 :size="16" />
            <span>Data Cleanup</span>
          </div>
        </template>
        <div class="section-body">
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
              {{ cleaningOrphans ? "Cleaning..." : "Clean Orphan Data" }}
            </el-button>
            <el-button
              size="small"
              type="danger"
              :loading="clearingAll"
              @click="showClearDialog = true"
            >
              <Trash2 :size="14" style="margin-right: 4px" />
              {{ clearingAll ? "Clearing..." : "Clear All KBs" }}
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
      </el-collapse-item>
    </el-collapse>

    <!-- Clear All KBs confirmation dialog -->
    <el-dialog
      v-model="showClearDialog"
      title="Clear All Knowledge Bases"
      width="450px"
      :close-on-click-modal="false"
    >
      <p style="margin: 0; line-height: 1.6">
        Are you sure you want to clear <strong>all</strong> knowledge bases? This action cannot be
        undone.
      </p>
      <template #footer>
        <el-button size="small" @click="showClearDialog = false">Cancel</el-button>
        <el-button size="small" type="danger" @click="handleClearAll">Clear All</el-button>
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
  padding: 4px;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 4px 8px;
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--el-bg-color);
}

.settings-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.settings-collapse {
  border: none;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  flex: 1;
  min-width: 0;
}

.hint-text {
  font-size: 12px;
  color: var(--el-text-color-disabled);
  margin-left: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 4px;
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
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-secondary);
  min-width: 140px;
  flex-shrink: 0;
}

.field-hint {
  font-size: 11px;
  color: var(--el-text-color-disabled);
  width: 100%;
  margin-top: -4px;
  line-height: 1.5;
}

.field-desc {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}

.link {
  color: var(--el-color-primary);
  text-decoration: underline;
}

.section-divider {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 4px;
}

.tool-limits-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin-bottom: -6px;
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

.status-dot-inline {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-left: 4px;
}

.status-green {
  background: var(--el-color-success);
}

.status-yellow {
  background: var(--el-color-warning);
  animation: pulse 1.5s ease-in-out infinite;
}

.status-gray {
  background: var(--el-text-color-disabled);
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
  color: var(--el-text-color-secondary);
}

.status-row-inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.local-model-box {
  padding: 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.url-display {
  font-size: 12px;
  padding: 4px 8px;
  background: var(--el-fill-color-lighter);
  border-radius: var(--el-border-radius-base);
  color: var(--el-text-color-regular);
}

.kb-select-list {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
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
  background: var(--el-fill-color-lighter);
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
  color: var(--el-text-color-disabled);
  flex-shrink: 0;
}

:deep(.el-collapse-item__header) {
  padding: 0 4px;
}

:deep(.el-collapse-item__content) {
  padding-bottom: 8px;
}
</style>