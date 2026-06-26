import { useEffect, useState, useRef } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useKBStore } from "../../stores/useKBStore";
import { useI18n } from "../../i18n";
import { configureClaudeMCP, getMcpConfigJson, clearAllKBs, exportKBs, importKBs } from "../../services/tauriBridge";
import { testEmbedding, testRerank, cleanOrphans } from "../../services/pythonClient";
import type { AppSettings } from "../../types";
import { Save, CheckCircle, Loader2, Terminal, Check, X, FolderOpen, RotateCcw, FlaskConical, Copy, ClipboardCheck, AlertTriangle, Trash2, Download, Upload, Settings } from "lucide-react";
import { ConfirmDialog } from "../common/ConfirmDialog";

const SECTIONS = [
  { id: "general", label: "settings.navGeneral" },
  { id: "models", label: "settings.navModels" },
  { id: "chat", label: "settings.navChat" },
  { id: "data", label: "settings.navData" },
] as const;

export function SettingsPanel() {
  const { t } = useI18n();
  const { settings, loadSettings, saveSettings, pythonRunning, startPython, restartPython } = useSettingsStore();
  const [form, setForm] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);
  const [claudeStatus, setClaudeStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [copiedMCP, setCopiedMCP] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState("general");
  const contentRef = useRef<HTMLDivElement>(null);

  const handleClearAll = async () => {
    setClearing(true);
    try {
      const count = await clearAllKBs();
      setClearResult(`Cleared ${count} knowledge base(s).`);
      setShowClearDialog(false);
      setTimeout(() => setClearResult(null), 4000);
    } catch (e) {
      setClearResult(`Error: ${e}`);
      setShowClearDialog(false);
      setTimeout(() => setClearResult(null), 4000);
    }
    setClearing(false);
  };

  // ── Export / Import ──
  const { knowledgeBases, loadKBs } = useKBStore();
  const [selectedKBs, setSelectedKBs] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dataResult, setDataResult] = useState<string | null>(null);

  useEffect(() => { loadKBs(); }, []);

  const toggleSelect = (id: string) => {
    setSelectedKBs(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedKBs(new Set(knowledgeBases.map(k => k.id)));
  const deselectAll = () => setSelectedKBs(new Set());

  const handleExport = async () => {
    if (selectedKBs.size === 0) return;
    setExporting(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      let defaultName: string;
      if (selectedKBs.size === 1) {
        const kb = knowledgeBases.find(k => k.id === [...selectedKBs][0]);
        const safeName = (kb?.name || "knowledge-base").replace(/[\\/:*?"<>|]/g, "-");
        defaultName = `${safeName}.zip`;
      } else {
        const date = new Date().toISOString().slice(0, 10);
        defaultName = `knowledge-bases-${selectedKBs.size}-${date}.zip`;
      }
      const path = await save({
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
        defaultPath: defaultName,
      });
      if (path) {
        await exportKBs([...selectedKBs], path);
        setDataResult(`Exported ${selectedKBs.size} knowledge base(s).`);
        setTimeout(() => setDataResult(null), 4000);
      }
    } catch (e) {
      setDataResult(`Export error: ${e}`);
      setTimeout(() => setDataResult(null), 4000);
    }
    setExporting(false);
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
        multiple: false,
      });
      if (selected) {
        const path = selected as string;
        const count = await importKBs(path);
        await loadKBs();
        setDataResult(`Imported ${count} knowledge base(s).`);
        setTimeout(() => setDataResult(null), 4000);
      }
    } catch (e) {
      setDataResult(`Import error: ${e}`);
      setTimeout(() => setDataResult(null), 4000);
    }
    setImporting(false);
  };

  const handleCopyMCPConfig = async () => {
    try {
      const config = await getMcpConfigJson();
      await navigator.clipboard.writeText(config);
      setCopiedMCP(true);
      setTimeout(() => setCopiedMCP(false), 2000);
    } catch {
      // clipboard may not be available
    }
  };

  const [configResult, setConfigResult] = useState<string | null>(null);
  const [cleaningOrphans, setCleaningOrphans] = useState(false);
  const [orphanResult, setOrphanResult] = useState<string | null>(null);

  const handleCleanOrphans = async () => {
    setCleaningOrphans(true);
    try {
      const result = await cleanOrphans();
      setOrphanResult(result.cleaned > 0
        ? t("settings.orphansCleaned", { count: result.cleaned })
        : t("settings.orphansNone"));
      setTimeout(() => setOrphanResult(null), 4000);
    } catch (e) {
      setOrphanResult(`Error: ${e}`);
      setTimeout(() => setOrphanResult(null), 4000);
    }
    setCleaningOrphans(false);
  };

  const handleExportConfig = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: "settings.json",
      });
      if (!path) return;
      // Write via Tauri invoke — use simple approach: copy the settings object
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, JSON.stringify(form, null, 2));
      setConfigResult(t("settings.configExported"));
      setTimeout(() => setConfigResult(null), 3000);
    } catch (e) {
      setConfigResult(`${t("settings.configError")}: ${e}`);
      setTimeout(() => setConfigResult(null), 4000);
    }
  };

  const handleImportConfig = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (!selected) return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const content = await readTextFile(selected as string);
      const parsed = JSON.parse(content);
      // Merge into form (preserve type-safe defaults for missing keys)
      if (parsed && typeof parsed === "object") {
        setForm((prev) => ({ ...prev, ...parsed }));
      }
      setConfigResult(t("settings.configImported"));
      setTimeout(() => setConfigResult(null), 3000);
    } catch (e) {
      setConfigResult(`${t("settings.configError")}: ${e}`);
      setTimeout(() => setConfigResult(null), 4000);
    }
  };

  const [testingEmbedding, setTestingEmbedding] = useState(false);
  const [testEmbeddingResult, setTestEmbeddingResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testingRerank, setTestingRerank] = useState(false);
  const [testRerankResult, setTestRerankResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => { loadSettings(); }, []);
  useEffect(() => { setForm(settings); }, [settings]);

  const handleSave = async () => {
    await saveSettings(form);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const update = (field: keyof AppSettings, value: string | number | boolean) =>
    setForm((p) => ({ ...p, [field]: value }));

  const scrollTo = (id: string) => {
    setActiveSection(id);
    document.getElementById(`settings-section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Track visible section on scroll
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const handleScroll = () => {
      for (const s of [...SECTIONS].reverse()) {
        const sec = document.getElementById(`settings-section-${s.id}`);
        if (sec) {
          const rect = sec.getBoundingClientRect();
          if (rect.top <= 160) { setActiveSection(s.id); break; }
        }
      }
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Header with save */}
      <div className="px-6 pt-4 pb-2 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-2xl font-bold">{t("settings.title")}</h2>
          <button onClick={handleSave}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90">
            {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? t("settings.saved") : t("settings.save")}
          </button>
        </div>

        {/* Sticky nav bar */}
        <div className="flex gap-0.5 overflow-x-auto pb-1 -mx-1 px-1">
          {SECTIONS.map((s) => (
            <button key={s.id}
              onClick={() => scrollTo(s.id)}
              className={`shrink-0 px-3 py-1 rounded-md text-xs transition-colors whitespace-nowrap ${
                activeSection === s.id
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-muted-foreground"
              }`}
            >
              {t(s.label)}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
        {/* ── General ── */}
        <section id="settings-section-general">
          <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.general")}</h3>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">{t("settings.dataDir")}</label>
            <div className="flex gap-2">
              <input type="text" value={form.data_dir}
                onChange={(e) => update("data_dir", e.target.value)}
                placeholder="~/.super-knowledge-base"
                className="flex-1 px-3 py-2 border rounded-md text-sm bg-background" />
              <button
                onClick={async () => {
                  try {
                    const { open } = await import("@tauri-apps/plugin-dialog");
                    const dir = await open({ directory: true, title: t("settings.dataDir") });
                    if (dir) update("data_dir", dir as string);
                  } catch { /* dialog cancelled */ }
                }}
                className="px-3 py-2 border rounded-md hover:bg-muted transition-colors"
                title={t("settings.browse")}
              >
                <FolderOpen className="w-4 h-4" />
              </button>
              <button
                onClick={() => update("data_dir", "")}
                disabled={!form.data_dir}
                className="px-3 py-2 border rounded-md hover:bg-muted transition-colors disabled:opacity-40"
                title={t("settings.resetDataDir")}
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t("settings.dataDirHint")}</p>
          </div>
        </section>

        {/* MinerU */}
        <section className="mb-8">
          <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.mineru")}</h3>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">{t("settings.mineruToken")}</label>
            <input type="password" value={form.mineru_token}
              onChange={(e) => update("mineru_token", e.target.value)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
          </div>
          <p className="text-xs text-muted-foreground -mt-3 mb-4">
            {t("settings.mineruHint")}:{" "}
            <a href="https://mineru.net/apiManage/docs" target="_blank" className="text-primary underline">MinerU API</a>
          </p>
        </section>

        {/* ── Models ── */}
        <div id="settings-section-models">

        {/* Embedding */}
        <section className="mb-8">
          <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.embedding")}</h3>
          {[{ l: t("settings.apiBase"), k: "embedding_api_base", ph: "https://api.openai.com/v1" },
            { l: t("settings.apiKey"), k: "embedding_api_key", ph: "" },
            { l: t("settings.model"), k: "embedding_model", ph: "text-embedding-3-small" }].map(({ l, k, ph }) => (
            <div key={k} className="mb-4">
              <label className="block text-sm font-medium mb-1">{l}</label>
              <input type={k.includes("key") ? "password" : "text"} value={(form as any)[k]}
                onChange={(e) => update(k as keyof AppSettings, e.target.value)} placeholder={ph}
                className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
            </div>
          ))}
          <button
            onClick={async () => {
              setTestingEmbedding(true); setTestEmbeddingResult(null);
              try {
                const r = await testEmbedding({
                  api_base: form.embedding_api_base, api_key: form.embedding_api_key, model: form.embedding_model,
                });
                setTestEmbeddingResult({
                  ok: r.valid,
                  msg: r.valid ? t("settings.testSuccess", { dim: String(r.dimension ?? "?") }) : `${t("settings.testFailed")}: ${r.detail || r.status}`,
                });
              } catch (e) {
                setTestEmbeddingResult({ ok: false, msg: `${t("settings.testFailed")}: ${String(e)}` });
              }
              setTestingEmbedding(false);
            }}
            disabled={testingEmbedding || !pythonRunning}
            className="flex items-center gap-2 px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={!pythonRunning ? t("settings.stopped") : undefined}
          >
            {testingEmbedding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
            {testingEmbedding ? t("settings.testing") : t("settings.testConnection")}
          </button>
          {testEmbeddingResult && (
            <div className={`mt-2 p-2.5 rounded-md text-xs flex items-start gap-2 ${testEmbeddingResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
              {testEmbeddingResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <span className="whitespace-pre-wrap">{testEmbeddingResult.msg}</span>
            </div>
          )}
        </section>

        {/* Rerank */}
        <section className="mb-8">
          <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.rerank")}</h3>
          {[{ l: t("settings.apiBase"), k: "rerank_api_base", ph: "https://api.jina.ai/v1" },
            { l: t("settings.apiKey"), k: "rerank_api_key", ph: "" },
            { l: t("settings.model"), k: "rerank_model", ph: "jina-reranker-v2-base-multilingual" }].map(({ l, k, ph }) => (
            <div key={k} className="mb-4">
              <label className="block text-sm font-medium mb-1">{l}</label>
              <input type={k.includes("key") ? "password" : "text"} value={(form as any)[k]}
                onChange={(e) => update(k as keyof AppSettings, e.target.value)} placeholder={ph}
                className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
            </div>
          ))}
          <button
            onClick={async () => {
              setTestingRerank(true); setTestRerankResult(null);
              try {
                const r = await testRerank({
                  api_base: form.rerank_api_base, api_key: form.rerank_api_key, model: form.rerank_model,
                });
                setTestRerankResult({
                  ok: r.valid,
                  msg: r.valid ? t("settings.testSuccessRerank") : `${t("settings.testFailed")}: ${r.detail || r.status}`,
                });
              } catch (e) {
                setTestRerankResult({ ok: false, msg: `${t("settings.testFailed")}: ${String(e)}` });
              }
              setTestingRerank(false);
            }}
            disabled={testingRerank || !pythonRunning}
            className="flex items-center gap-2 px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={!pythonRunning ? t("settings.stopped") : undefined}
          >
            {testingRerank ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
            {testingRerank ? t("settings.testing") : t("settings.testConnection")}
          </button>
          {testRerankResult && (
            <div className={`mt-2 p-2.5 rounded-md text-xs flex items-start gap-2 ${testRerankResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
              {testRerankResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <span className="whitespace-pre-wrap">{testRerankResult.msg}</span>
            </div>
          )}
        </section>

        {/* LLM for Chat */}
        <section className="mb-8">
          <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.llm")}</h3>
          {[
            { l: t("settings.apiBase"), k: "llm_api_base", ph: "https://api.openai.com/v1" },
            { l: t("settings.apiKey"), k: "llm_api_key", ph: "" },
            { l: t("settings.model"), k: "llm_model", ph: "gpt-4o-mini" },
          ].map(({ l, k, ph }) => (
            <div key={k} className="mb-3">
              <label className="block text-sm font-medium mb-1">{l}</label>
              <input type={k.includes("key") ? "password" : "text"}
                value={(form as any)[k] || ""}
                onChange={(e) => update(k as any, e.target.value)}
                placeholder={ph}
                className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
            </div>
          ))}
        </section>

        </div>
        {/* ── Chat ── */}
        <div id="settings-section-chat">

        {/* Tool Limits */}
        <section className="mb-8">
          <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.toolLimits")}</h3>
          {[
            { l: t("settings.maxToolRounds"), k: "max_tool_rounds", ph: "10" },
            { l: t("settings.maxHistoryMessages"), k: "max_history_messages", ph: "80" },
            { l: t("settings.maxSearchResultChars"), k: "max_search_result_chars", ph: "2000" },
            { l: t("settings.maxDocumentChars"), k: "max_document_chars", ph: "30000" },
            { l: t("settings.maxChunkChars"), k: "max_chunk_chars", ph: "800" },
          ].map(({ l, k, ph }) => (
            <div key={k} className="mb-3">
              <label className="block text-sm font-medium mb-1">{l}</label>
              <input type="number"
                value={(form as any)[k] ?? ph}
                onChange={(e) => update(k as any, Number(e.target.value))}
                placeholder={ph}
                className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
            </div>
          ))}
        </section>

        {/* Chunking */}
        <section className="mb-8">
          <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.chunking")}</h3>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">{t("settings.strategy")}</label>
            <select value={form.chunk_strategy} onChange={(e) => update("chunk_strategy", e.target.value)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background">
              <option value="recursive">{t("settings.recursive")}</option>
              <option value="semantic">{t("settings.semantic")}</option>
              <option value="fixed">{t("settings.fixed")}</option>
            </select>
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">{t("settings.chunkSize")}</label>
            <input type="number" value={form.chunk_size}
              onChange={(e) => update("chunk_size", parseInt(e.target.value) || 512)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">{t("settings.chunkOverlap")}</label>
            <input type="number" value={form.chunk_overlap}
              onChange={(e) => update("chunk_overlap", parseInt(e.target.value) || 50)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
          </div>
        </section>

        </div>

        {/* Python Backend */}
        <section className="mb-8">
          <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.python")}</h3>
          <div className="flex items-center gap-3 mb-4">
            <span className={`w-2 h-2 rounded-full ${pythonRunning ? "bg-green-500" : "bg-red-500"}`} />
            <span className="text-sm">{pythonRunning ? t("settings.running") : t("settings.stopped")}</span>
            {pythonRunning ? (
              <button onClick={restartPython} className="px-3 py-1 border rounded text-xs hover:bg-muted transition-colors">
                {t("settings.restartBackend")}
              </button>
            ) : (
              <button onClick={startPython} className="px-3 py-1 bg-primary text-primary-foreground rounded text-xs">
                {t("settings.startBackend")}
              </button>
            )}
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">{t("settings.port")}</label>
            <input type="number" value={form.python_port}
              onChange={(e) => update("python_port", parseInt(e.target.value) || 17390)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
          </div>
        </section>

        {/* Claude Code MCP */}
        <section className="mb-8">
          <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.claudeMCP")}</h3>
          <p className="text-sm text-muted-foreground mb-4">{t("settings.claudeMCPDesc")}</p>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                setConfiguring(true); setClaudeStatus(null);
                try {
                  const result = await configureClaudeMCP();
                  setClaudeStatus({ success: result.success, message: result.message });
                } catch (e) {
                  setClaudeStatus({ success: false, message: String(e) });
                }
                setConfiguring(false);
              }}
              disabled={configuring}
              className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {configuring ? <Loader2 className="w-4 h-4 animate-spin" /> : <Terminal className="w-4 h-4" />}
              {t("settings.configureClaude")}
            </button>
            <button onClick={handleCopyMCPConfig}
              className="flex items-center gap-2 px-4 py-2.5 border rounded-lg text-sm font-medium hover:bg-muted transition-colors"
            >
              {copiedMCP ? <ClipboardCheck className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              {copiedMCP ? t("settings.saved") : t("settings.copyMCPConfig")}
            </button>
          </div>
          {claudeStatus && (
            <div className={`mt-3 p-3 rounded-lg text-sm flex items-start gap-2 ${claudeStatus.success ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
              {claudeStatus.success ? <Check className="w-4 h-4 mt-0.5 shrink-0" /> : <X className="w-4 h-4 mt-0.5 shrink-0" />}
              <p className="whitespace-pre-wrap">{claudeStatus.message}</p>
            </div>
          )}
        </section>

        {/* ── Data ── */}
        <div id="settings-section-data">

        {/* Export / Import */}
        <section className="p-6 bg-card border rounded-xl space-y-4 mb-6">
          <div className="flex items-center gap-2">
            <Download className="w-5 h-5 text-primary" />
            <h2 className="font-semibold">{t("settings.export")}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t("settings.exportDesc")}</p>
          {knowledgeBases.length > 0 && (
            <>
              <div className="flex gap-2">
                <button onClick={selectAll} className="text-xs text-muted-foreground hover:text-foreground underline">{t("settings.selectAll")}</button>
                <button onClick={deselectAll} className="text-xs text-muted-foreground hover:text-foreground underline">{t("settings.deselectAll")}</button>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-0.5 border rounded-md p-2">
                {knowledgeBases.map(kb => (
                  <label key={kb.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-2 py-1">
                    <input type="checkbox" checked={selectedKBs.has(kb.id)} onChange={() => toggleSelect(kb.id)} className="rounded" />
                    <span className="truncate">{kb.name}</span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">{kb.document_count}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          <button onClick={handleExport} disabled={exporting || selectedKBs.size === 0}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
            <Download className="w-4 h-4" />
            {exporting ? t("settings.exporting") : `${t("settings.exportBtn")} (${selectedKBs.size})`}
          </button>
        </section>

        <section className="p-6 bg-card border rounded-xl space-y-4 mb-6">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" />
            <h2 className="font-semibold">{t("settings.import")}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t("settings.importDesc")}</p>
          <button onClick={handleImport} disabled={importing}
            className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50">
            <Upload className="w-4 h-4" />
            {importing ? t("settings.importing") : t("settings.importBtn")}
          </button>
        </section>

        {dataResult && (
          <p className="text-sm text-muted-foreground text-center">{dataResult}</p>
        )}

        {/* Config Import/Export */}
        <section className="p-6 bg-card border rounded-xl space-y-4 mb-6">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-primary" />
            <h2 className="font-semibold">{t("settings.configIO")}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t("settings.configIODesc")}</p>
          <div className="flex gap-3">
            <button onClick={handleExportConfig}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90">
              <Download className="w-4 h-4" />
              {t("settings.exportConfig")}
            </button>
            <button onClick={handleImportConfig}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted transition-colors">
              <Upload className="w-4 h-4" />
              {t("settings.importConfig")}
            </button>
          </div>
          {configResult && (
            <p className="text-sm text-muted-foreground">{configResult}</p>
          )}
        </section>

        {/* Clear All Knowledge Bases */}
        <section className="p-6 bg-card border rounded-xl space-y-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-500" />
            <h2 className="font-semibold">{t("settings.clearAll")}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t("settings.clearAllDesc")}</p>
          <div className="flex gap-3">
            <button
              onClick={handleCleanOrphans}
              disabled={cleaningOrphans || !pythonRunning}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
              title={!pythonRunning ? t("settings.stopped") : undefined}
            >
              <Trash2 className="w-4 h-4" />
              {cleaningOrphans ? t("settings.cleaning") : t("settings.cleanOrphans")}
            </button>
            <button
              onClick={() => setShowClearDialog(true)}
              disabled={clearing}
              className="flex items-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              {clearing ? t("settings.clearing") : t("settings.clearAllBtn")}
            </button>
          </div>
          {orphanResult && (
            <p className="text-sm text-muted-foreground">{orphanResult}</p>
          )}
          {clearResult && (
            <p className="text-sm text-muted-foreground">{clearResult}</p>
          )}
        </section>

        <ConfirmDialog
          open={showClearDialog}
          title={t("settings.clearAll")}
          message={t("settings.clearAllConfirm")}
          confirmLabel={t("settings.clearAllConfirmBtn")}
          cancelLabel={t("kb.cancel")}
          danger={true}
          onConfirm={handleClearAll}
          onCancel={() => setShowClearDialog(false)}
        />

        </div>
        {/* end data section */}
      </div>
    </div>
  );
}
