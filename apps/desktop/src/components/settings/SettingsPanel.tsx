import { useEffect, useState, useRef } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useKBStore } from "../../stores/useKBStore";
import { useI18n } from "../../i18n";
import { configureClaudeMCP, getMcpConfigJson, clearAllKBs, exportKBs, importKBs } from "../../services/tauriBridge";
import { testEmbedding, testRerank, testLLM, testVLM, cleanOrphans, checkLlamaStatus } from "../../services/pythonClient";
import type { AppSettings } from "../../types";
import { DEFAULT_SETTINGS } from "../../types";
import { Save, CheckCircle, Loader2, Terminal, Check, X, FolderOpen, RotateCcw, FlaskConical, Copy, ClipboardCheck, AlertTriangle, Trash2, Download, Upload, Settings, ChevronDown, ChevronRight } from "lucide-react";
import { ConfirmDialog } from "../common/ConfirmDialog";

function LocalModelStatus({ port, kind }: { port: number; kind: "embedding" | "rerank" }) {
  const [state, setState] = useState<"running" | "starting" | "stopped">("stopped");
  const { t } = useI18n();
  useEffect(() => {
    const poll = async () => {
      try {
        const s: any = await checkLlamaStatus();
        const info = s[kind] || {};
        if (info.running) setState("running");
        else if (info.starting) setState("starting");
        else setState("stopped");
      } catch { setState("stopped"); }
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => clearInterval(iv);
  }, [port, kind]);
  const labels = { running: t("settings.llamaRunning"), starting: t("settings.llamaStarting"), stopped: t("settings.llamaStopped") };
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-2 h-2 rounded-full ${state === "running" ? "bg-green-500" : state === "starting" ? "bg-yellow-500 animate-pulse" : "bg-gray-400"}`} />
      <span className="text-muted-foreground">{labels[state]}</span>
    </div>
  );
}

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

  const formInitialized = useRef(false);
  useEffect(() => { loadSettings(); }, []);
  useEffect(() => {
    if (!formInitialized.current && settings !== DEFAULT_SETTINGS) {
      setForm(settings);
      formInitialized.current = true;
    }
  }, [settings]);

  const handleSave = async () => {
    await saveSettings(form);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };
  const update = (field: keyof AppSettings, value: string | number | boolean) =>
    setForm((p) => ({ ...p, [field]: value }));

  // Collapse state
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpenSections(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });
  const isOpen = (id: string) => openSections.has(id);

  function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
    const open = isOpen(id);
    const handleToggle = () => {
      const before = document.getElementById(`section-${id}`)?.getBoundingClientRect().top;
      toggle(id);
      if (before != null) {
        requestAnimationFrame(() => {
          const el = document.getElementById(`section-${id}`);
          const after = el?.getBoundingClientRect().top;
          if (after != null && el?.parentElement) {
            el.parentElement.scrollTop += after - before;
          }
        });
      }
    };
    return (
      <div className="border rounded-xl bg-card overflow-hidden" id={`section-${id}`}>
        <button
          onClick={handleToggle}
          className="w-full flex items-center gap-2 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
        >
          {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
          <span className="text-sm font-semibold">{title}</span>
          {hint && !open && <span className="text-xs text-muted-foreground truncate ml-2 hidden sm:inline">{hint}</span>}
        </button>
        {open && <div className="px-4 pb-4 pt-1 space-y-3">{children}</div>}
      </div>
    );
  }

  // ── Export / Import ──
  const { knowledgeBases, loadKBs } = useKBStore();
  const [selectedKBs, setSelectedKBs] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dataResult, setDataResult] = useState<string | null>(null);
  useEffect(() => { loadKBs(); }, []);
  const toggleSelect = (id: string) => setSelectedKBs(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setSelectedKBs(new Set(knowledgeBases.map(k => k.id)));
  const deselectAll = () => setSelectedKBs(new Set());

  const handleExport = async () => {
    if (selectedKBs.size === 0) return; setExporting(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      let dn: string;
      if (selectedKBs.size === 1) {
        const kb = knowledgeBases.find(k => k.id === [...selectedKBs][0]);
        dn = `${(kb?.name || "kb").replace(/[\\/:*?"<>|]/g, "-")}.zip`;
      } else { dn = `kbs-${selectedKBs.size}-${new Date().toISOString().slice(0, 10)}.zip`; }
      const path = await save({ filters: [{ name: "ZIP", extensions: ["zip"] }], defaultPath: dn });
      if (path) { await exportKBs([...selectedKBs], path); setDataResult(`Exported ${selectedKBs.size} KB(s).`); setTimeout(() => setDataResult(null), 4000); }
    } catch (e) { setDataResult(`Error: ${e}`); setTimeout(() => setDataResult(null), 4000); }
    setExporting(false);
  };
  const handleImport = async () => { setImporting(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ filters: [{ name: "ZIP", extensions: ["zip"] }], multiple: false });
      if (sel) { const c = await importKBs(sel as string); await loadKBs(); setDataResult(`Imported ${c} KB(s).`); setTimeout(() => setDataResult(null), 4000); }
    } catch (e) { setDataResult(`Error: ${e}`); setTimeout(() => setDataResult(null), 4000); }
    setImporting(false);
  };

  const handleCopyMCPConfig = async () => {
    try { const c = await getMcpConfigJson(); await navigator.clipboard.writeText(c); setCopiedMCP(true); setTimeout(() => setCopiedMCP(false), 2000); } catch {}
  };
  const [configResult, setConfigResult] = useState<string | null>(null);
  const [cleaningOrphans, setCleaningOrphans] = useState(false);
  const [orphanResult, setOrphanResult] = useState<string | null>(null);
  const handleCleanOrphans = async () => { setCleaningOrphans(true);
    try {
      const r = await cleanOrphans();
      setOrphanResult(r.cleaned > 0 ? t("settings.orphansCleaned", { count: r.cleaned }) : t("settings.orphansNone"));
      setTimeout(() => setOrphanResult(null), 4000);
    } catch (e) { setOrphanResult(`Error: ${e}`); setTimeout(() => setOrphanResult(null), 4000); }
    setCleaningOrphans(false);
  };
  const handleClearAll = async () => { setClearing(true);
    try { const c = await clearAllKBs(); setClearResult(`Cleared ${c} KB(s).`); setShowClearDialog(false); setTimeout(() => setClearResult(null), 4000); }
    catch (e) { setClearResult(`Error: ${e}`); setShowClearDialog(false); setTimeout(() => setClearResult(null), 4000); }
    setClearing(false);
  };
  const handleExportConfig = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const p = await save({ filters: [{ name: "JSON", extensions: ["json"] }], defaultPath: "settings.json" });
      if (!p) return;
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(p, JSON.stringify(form, null, 2));
      setConfigResult(t("settings.configExported")); setTimeout(() => setConfigResult(null), 3000);
    } catch (e) { setConfigResult(`${t("settings.configError")}: ${e}`); setTimeout(() => setConfigResult(null), 4000); }
  };
  const handleImportConfig = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ filters: [{ name: "JSON", extensions: ["json"] }], multiple: false });
      if (!sel) return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const c = JSON.parse(await readTextFile(sel as string));
      if (c && typeof c === "object") setForm(prev => ({ ...prev, ...c }));
      setConfigResult(t("settings.configImported")); setTimeout(() => setConfigResult(null), 3000);
    } catch (e) { setConfigResult(`${t("settings.configError")}: ${e}`); setTimeout(() => setConfigResult(null), 4000); }
  };

  const [testingEmbedding, setTestingEmbedding] = useState(false);
  const [testEmbeddingResult, setTestEmbeddingResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testingRerank, setTestingRerank] = useState(false);
  const [testRerankResult, setTestRerankResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testingLLM, setTestingLLM] = useState(false);
  const [testLLMResult, setTestLLMResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testingVLM, setTestingVLM] = useState(false);
  const [testVLMResult, setTestVLMResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const testEmbed = async () => { setTestingEmbedding(true); setTestEmbeddingResult(null);
    try {
      const base = form.use_local_embedding ? `http://127.0.0.1:${form.llama_port || 8081}` : form.embedding_api_base;
      const key = form.use_local_embedding ? "local" : form.embedding_api_key;
      const model = form.use_local_embedding ? ((form.local_embedding_model || "local").replace(/\.gguf$/i, "").split(/[/\\]/).pop() || "local") : form.embedding_model;
      const r = await testEmbedding({ api_base: base, api_key: key, model });
      setTestEmbeddingResult({ ok: r.valid, msg: r.valid ? t("settings.testSuccess", { dim: String(r.dimension ?? "?") }) : `${t("settings.testFailed")}: ${r.detail || r.status}` });
    } catch (e) { setTestEmbeddingResult({ ok: false, msg: `${t("settings.testFailed")}: ${String(e)}` }); }
    setTestingEmbedding(false);
  };
  const testRnk = async () => { setTestingRerank(true); setTestRerankResult(null);
    try {
      const base = form.use_local_rerank ? `http://127.0.0.1:${(form.llama_port || 8081) + 1}` : form.rerank_api_base;
      const key = form.use_local_rerank ? "local" : form.rerank_api_key;
      const model = form.use_local_rerank ? ((form.local_rerank_model || "local").replace(/\.gguf$/i, "").split(/[/\\]/).pop() || "local") : form.rerank_model;
      const r = await testRerank({ api_base: base, api_key: key, model });
      setTestRerankResult({ ok: r.valid, msg: r.valid ? t("settings.testSuccessRerank") : `${t("settings.testFailed")}: ${r.detail || r.status}` });
    } catch (e) { setTestRerankResult({ ok: false, msg: `${t("settings.testFailed")}: ${String(e)}` }); }
    setTestingRerank(false);
  };
  const handleTestLLM = async () => { setTestingLLM(true); setTestLLMResult(null);
    try {
      const r = await testLLM({ api_base: form.llm_api_base, api_key: form.llm_api_key, model: form.llm_model });
      setTestLLMResult({ ok: r.valid, msg: r.valid ? t("settings.testSuccessPass") : `${t("settings.testFailed")}: ${r.detail || r.status}` });
    } catch (e) { setTestLLMResult({ ok: false, msg: `${t("settings.testFailed")}: ${String(e)}` }); }
    setTestingLLM(false);
  };
  const handleTestVLM = async () => { setTestingVLM(true); setTestVLMResult(null);
    try {
      const r = await testVLM({ api_base: form.vlm_api_base, api_key: form.vlm_api_key, model: form.vlm_model });
      setTestVLMResult({ ok: r.valid, msg: r.valid ? t("settings.testSuccessPass") : `${t("settings.testFailed")}: ${r.detail || r.status}` });
    } catch (e) { setTestVLMResult({ ok: false, msg: `${t("settings.testFailed")}: ${String(e)}` }); }
    setTestingVLM(false);
  };

  const inputField = (k: string, ph: string) => (
    <div key={k}>
      <label className="block text-sm font-medium mb-1">{t(`settings.${k.replace(/_/g, "")}` as any) || k}</label>
      <input type={k.includes("key") || k.includes("token") ? "password" : "text"}
        value={(form as any)[k] || ""} onChange={(e) => update(k as any, e.target.value)} placeholder={ph}
        className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
    </div>
  );

  const Toggle = ({ field, label }: { field: keyof AppSettings; label: string }) => (
    <div className="flex items-center justify-between">
      <span className="text-sm">{label}</span>
      <button onClick={() => update(field, !form[field])}
        className={`relative w-10 h-5 rounded-full transition-colors ${form[field] ? "bg-primary" : "bg-gray-300"}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${form[field] ? "left-5" : "left-0.5"}`} />
      </button>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-4 pb-2 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-2xl font-bold">{t("settings.title")}</h2>
          <button onClick={handleSave}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90">
            {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? t("settings.saved") : t("settings.save")}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-3">

        {/* Data Directory */}
        <Section id="general" title={t("settings.general")} hint={form.data_dir || "~/.super-knowledge-base"}>
          <label className="block text-sm font-medium">{t("settings.dataDir")}</label>
          <div className="flex gap-2">
            <input type="text" value={form.data_dir}
              onChange={(e) => update("data_dir", e.target.value)} placeholder="~/.super-knowledge-base"
              className="flex-1 px-3 py-2 border rounded-md text-sm bg-background" />
            <button onClick={async () => { try { const { open } = await import("@tauri-apps/plugin-dialog"); const d = await open({ directory: true }); if (d) update("data_dir", d as string); } catch {} }}
              className="px-3 py-2 border rounded-md hover:bg-muted"><FolderOpen className="w-4 h-4" /></button>
            <button onClick={() => update("data_dir", "")} disabled={!form.data_dir}
              className="px-3 py-2 border rounded-md hover:bg-muted disabled:opacity-40"><RotateCcw className="w-4 h-4" /></button>
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.dataDirHint")}</p>
        </Section>

        {/* MinerU */}
        <Section id="mineru" title={t("settings.mineru")} hint={form.mineru_token ? "Token configured" : ""}>
          <div>
            <label className="block text-sm font-medium mb-1">{t("settings.mineruToken")}</label>
            <input type="password" value={form.mineru_token}
              onChange={(e) => update("mineru_token", e.target.value)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.mineruHint")}: <a href="https://mineru.net/apiManage/docs" target="_blank" className="text-primary underline">MinerU API</a>
          </p>
        </Section>

        {/* Embedding */}
        <Section id="embedding" title={t("settings.embedding")} hint={form.use_local_embedding ? "Local" : form.embedding_model}>
          <Toggle field="use_local_embedding" label={t("settings.useLocal")} />
          {form.use_local_embedding ? (
            <div className="p-3 bg-muted/50 rounded-lg space-y-3">
              <LocalModelStatus port={form.llama_port || 8081} kind="embedding" />
              <div>
                <label className="block text-xs font-medium mb-1">{t("settings.modelFile")}</label>
                <div className="flex gap-2">
                  <input type="text" value={form.local_embedding_model}
                    onChange={(e) => update("local_embedding_model", e.target.value)}
                    placeholder="Qwen3-Embedding-0.6B-Q8_0.gguf"
                    className="flex-1 px-3 py-2 border rounded-md text-sm bg-background" />
                  <button onClick={async () => { try { const { open } = await import("@tauri-apps/plugin-dialog"); const f = await open({ filters: [{ name: "GGUF", extensions: ["gguf"] }] }); if (f) update("local_embedding_model", f as string); } catch {} }}
                    className="px-3 py-2 border rounded-md hover:bg-muted"><FolderOpen className="w-4 h-4" /></button>
                </div>
              </div>
              <button onClick={testEmbed} disabled={testingEmbedding || !pythonRunning}
                className="flex items-center gap-2 px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted disabled:opacity-40">
                {testingEmbedding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
                {testingEmbedding ? t("settings.testing") : t("settings.testConnection")}
              </button>
              {testEmbeddingResult && (
                <div className={`p-2.5 rounded-md text-xs flex items-start gap-2 ${testEmbeddingResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
                  {testEmbeddingResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                  <span>{testEmbeddingResult.msg}</span>
                </div>
              )}
            </div>
          ) : (
            <>
              {[
                { l: t("settings.apiBase"), k: "embedding_api_base", ph: "https://api.openai.com/v1" },
                { l: t("settings.apiKey"), k: "embedding_api_key", ph: "" },
                { l: t("settings.model"), k: "embedding_model", ph: "text-embedding-3-small" },
              ].map(({ l, k, ph }) => (
                <div key={k}>
                  <label className="block text-sm font-medium mb-1">{l}</label>
                  <input type={k.includes("key") ? "password" : "text"} value={(form as any)[k]}
                    onChange={(e) => update(k as keyof AppSettings, e.target.value)} placeholder={ph}
                    className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
                </div>
              ))}
              <button onClick={testEmbed} disabled={testingEmbedding || !pythonRunning}
                className="flex items-center gap-2 px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted disabled:opacity-40">
                {testingEmbedding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
                {testingEmbedding ? t("settings.testing") : t("settings.testConnection")}
              </button>
              {testEmbeddingResult && (
                <div className={`p-2.5 rounded-md text-xs flex items-start gap-2 ${testEmbeddingResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
                  {testEmbeddingResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                  <span>{testEmbeddingResult.msg}</span>
                </div>
              )}
            </>
          )}
        </Section>

        {/* Rerank */}
        <Section id="rerank" title={t("settings.rerank")} hint={form.use_local_rerank ? "Local" : form.rerank_model}>
          <Toggle field="use_local_rerank" label={t("settings.useLocal")} />
          {form.use_local_rerank ? (
            <div className="p-3 bg-muted/50 rounded-lg space-y-3">
              <LocalModelStatus port={(form.llama_port || 8081) + 1} kind="rerank" />
              <div>
                <label className="block text-xs font-medium mb-1">{t("settings.modelFile")}</label>
                <div className="flex gap-2">
                  <input type="text" value={form.local_rerank_model}
                    onChange={(e) => update("local_rerank_model", e.target.value)} placeholder="qwen3-reranker-0.6b-q8_0.gguf"
                    className="flex-1 px-3 py-2 border rounded-md text-sm bg-background" />
                  <button onClick={async () => { try { const { open } = await import("@tauri-apps/plugin-dialog"); const f = await open({ filters: [{ name: "GGUF", extensions: ["gguf"] }] }); if (f) update("local_rerank_model", f as string); } catch {} }}
                    className="px-3 py-2 border rounded-md hover:bg-muted"><FolderOpen className="w-4 h-4" /></button>
                </div>
              </div>
              <button onClick={testRnk} disabled={testingRerank || !pythonRunning}
                className="flex items-center gap-2 px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted disabled:opacity-40">
                {testingRerank ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
                {testingRerank ? t("settings.testing") : t("settings.testConnection")}
              </button>
              {testRerankResult && (
                <div className={`p-2.5 rounded-md text-xs flex items-start gap-2 ${testRerankResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
                  {testRerankResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                  <span>{testRerankResult.msg}</span>
                </div>
              )}
            </div>
          ) : (
            <>
              {[
                { l: t("settings.apiBase"), k: "rerank_api_base", ph: "https://api.jina.ai/v1" },
                { l: t("settings.apiKey"), k: "rerank_api_key", ph: "" },
                { l: t("settings.model"), k: "rerank_model", ph: "jina-reranker-v2-base-multilingual" },
              ].map(({ l, k, ph }) => (
                <div key={k}>
                  <label className="block text-sm font-medium mb-1">{l}</label>
                  <input type={k.includes("key") ? "password" : "text"} value={(form as any)[k]}
                    onChange={(e) => update(k as keyof AppSettings, e.target.value)} placeholder={ph}
                    className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
                </div>
              ))}
              <button onClick={testRnk} disabled={testingRerank || !pythonRunning}
                className="flex items-center gap-2 px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted disabled:opacity-40">
                {testingRerank ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
                {testingRerank ? t("settings.testing") : t("settings.testConnection")}
              </button>
              {testRerankResult && (
                <div className={`p-2.5 rounded-md text-xs flex items-start gap-2 ${testRerankResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
                  {testRerankResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                  <span>{testRerankResult.msg}</span>
                </div>
              )}
            </>
          )}
        </Section>

        {/* LLM */}
        <Section id="llm" title={t("settings.llm")} hint={form.llm_model}>
          {[
            { l: t("settings.apiBase"), k: "llm_api_base", ph: "https://api.openai.com/v1" },
            { l: t("settings.apiKey"), k: "llm_api_key", ph: "" },
            { l: t("settings.model"), k: "llm_model", ph: "gpt-4o-mini" },
          ].map(({ l, k, ph }) => (
            <div key={k}>
              <label className="block text-sm font-medium mb-1">{l}</label>
              <input type={k.includes("key") ? "password" : "text"} value={(form as any)[k] || ""}
                onChange={(e) => update(k as any, e.target.value)} placeholder={ph}
                className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
            </div>
          ))}
          <button onClick={handleTestLLM} disabled={testingLLM || !form.llm_api_base || !form.llm_model}
            className="flex items-center gap-2 px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted disabled:opacity-40">
            {testingLLM ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
            {testingLLM ? t("settings.testing") : t("settings.testConnection")}
          </button>
          {testLLMResult && (
            <div className={`p-2.5 rounded-md text-xs flex items-start gap-2 ${testLLMResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
              {testLLMResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <span>{testLLMResult.msg}</span>
            </div>
          )}
          <div className="border-t pt-3 mt-2">
            <p className="text-xs font-medium text-muted-foreground mb-2">{t("settings.toolLimits")}</p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { l: t("settings.maxToolRounds"), k: "max_tool_rounds", ph: "100" },
                { l: t("settings.maxHistoryMessages"), k: "max_history_messages", ph: "80" },
                { l: t("settings.maxSearchResultChars"), k: "max_search_result_chars", ph: "2000" },
                { l: t("settings.maxDocumentChars"), k: "max_document_chars", ph: "30000" },
                { l: t("settings.maxChunkChars"), k: "max_chunk_chars", ph: "800" },
              ].map(({ l, k, ph }) => (
                <div key={k}>
                  <label className="block text-xs font-medium mb-1">{l}</label>
                  <input type="number" value={(form as any)[k] ?? ph} onChange={(e) => update(k as any, Number(e.target.value))} placeholder={ph}
                    className="w-full px-2 py-1.5 border rounded-md text-xs bg-background" />
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* VLM */}
        <Section id="vlm" title={t("settings.vlm")} hint={form.vlm_model || t("settings.vlmHint")}>
          <p className="text-xs text-muted-foreground">{t("settings.vlmHint")}</p>
          {[
            { l: t("settings.apiBase"), k: "vlm_api_base", ph: "https://api.openai.com/v1" },
            { l: t("settings.apiKey"), k: "vlm_api_key", ph: "" },
            { l: t("settings.model"), k: "vlm_model", ph: "gpt-4o" },
          ].map(({ l, k, ph }) => (
            <div key={k}>
              <label className="block text-sm font-medium mb-1">{l}</label>
              <input type={k.includes("key") ? "password" : "text"} value={(form as any)[k] || ""}
                onChange={(e) => update(k as any, e.target.value)} placeholder={ph}
                className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
            </div>
          ))}
          <Toggle field="extract_multimodal" label={t("settings.extractMultimodal")} />
          <p className="text-xs text-muted-foreground">{t("settings.extractMultimodalHint")}</p>
          <button onClick={handleTestVLM} disabled={testingVLM || !form.vlm_api_base || !form.vlm_model}
            className="flex items-center gap-2 px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted disabled:opacity-40">
            {testingVLM ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
            {testingVLM ? t("settings.testing") : t("settings.testConnection")}
          </button>
          {testVLMResult && (
            <div className={`p-2.5 rounded-md text-xs flex items-start gap-2 ${testVLMResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
              {testVLMResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <span>{testVLMResult.msg}</span>
            </div>
          )}
        </Section>

        {/* Chunking */}
        <Section id="chunking" title={t("settings.chunking")}>
          <div>
            <label className="block text-sm font-medium mb-1">{t("settings.strategy")}</label>
            <select value={form.chunk_strategy} onChange={(e) => update("chunk_strategy", e.target.value)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background">
              <option value="recursive">{t("settings.recursive")}</option>
              <option value="semantic">{t("settings.semantic")}</option>
              <option value="fixed">{t("settings.fixed")}</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t("settings.chunkSize")}</label>
            <input type="number" value={form.chunk_size}
              onChange={(e) => update("chunk_size", parseInt(e.target.value) || 512)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t("settings.chunkOverlap")}</label>
            <input type="number" value={form.chunk_overlap}
              onChange={(e) => update("chunk_overlap", parseInt(e.target.value) || 50)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
          </div>
        </Section>

        {/* Python */}
        <Section id="python" title={t("settings.python")} hint={pythonRunning ? t("settings.running") : t("settings.stopped")}>
          <div className="flex items-center gap-3">
            <span className={`w-2 h-2 rounded-full ${pythonRunning ? "bg-green-500" : "bg-red-500"}`} />
            <span className="text-sm">{pythonRunning ? t("settings.running") : t("settings.stopped")}</span>
            {pythonRunning
              ? <button onClick={restartPython} className="px-3 py-1 border rounded text-xs hover:bg-muted">{t("settings.restartBackend")}</button>
              : <button onClick={startPython} className="px-3 py-1 bg-primary text-primary-foreground rounded text-xs">{t("settings.startBackend")}</button>
            }
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t("settings.port")}</label>
            <input type="number" value={form.python_port}
              onChange={(e) => update("python_port", parseInt(e.target.value) || 17390)}
              className="w-full px-3 py-2 border rounded-md text-sm bg-background" />
          </div>
        </Section>

        {/* Claude MCP */}
        <Section id="claude" title={t("settings.claudeMCP")}>
          <p className="text-sm text-muted-foreground">{t("settings.claudeMCPDesc")}</p>
          <div className="flex gap-2">
            <button onClick={async () => { setConfiguring(true); setClaudeStatus(null);
              try { const r = await configureClaudeMCP(); setClaudeStatus({ success: r.success, message: r.message }); } catch (e) { setClaudeStatus({ success: false, message: String(e) }); }
              setConfiguring(false); }}
              disabled={configuring}
              className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50">
              {configuring ? <Loader2 className="w-4 h-4 animate-spin" /> : <Terminal className="w-4 h-4" />}
              {t("settings.configureClaude")}
            </button>
            <button onClick={handleCopyMCPConfig}
              className="flex items-center gap-2 px-4 py-2.5 border rounded-lg text-sm font-medium hover:bg-muted">
              {copiedMCP ? <ClipboardCheck className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
              {copiedMCP ? t("settings.saved") : t("settings.copyMCPConfig")}
            </button>
          </div>
          {claudeStatus && (
            <div className={`p-3 rounded-lg text-sm flex items-start gap-2 ${claudeStatus.success ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
              {claudeStatus.success ? <Check className="w-4 h-4 mt-0.5 shrink-0" /> : <X className="w-4 h-4 mt-0.5 shrink-0" />}
              <p className="whitespace-pre-wrap">{claudeStatus.message}</p>
            </div>
          )}
        </Section>

        {/* Export/Import */}
        <Section id="export" title={t("settings.export")} hint={`${selectedKBs.size} selected`}>
          <p className="text-sm text-muted-foreground">{t("settings.exportDesc")}</p>
          {knowledgeBases.length > 0 && <>
            <div className="flex gap-2">
              <button onClick={selectAll} className="text-xs text-muted-foreground hover:text-foreground underline">{t("settings.selectAll")}</button>
              <button onClick={deselectAll} className="text-xs text-muted-foreground hover:text-foreground underline">{t("settings.deselectAll")}</button>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-0.5 border rounded-md p-2">
              {knowledgeBases.map(kb => (
                <label key={kb.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-2 py-1">
                  <input type="checkbox" checked={selectedKBs.has(kb.id)} onChange={() => toggleSelect(kb.id)} className="rounded" />
                  <span className="truncate">{kb.name}</span><span className="text-xs text-muted-foreground ml-auto shrink-0">{kb.document_count}</span>
                </label>
              ))}
            </div>
          </>}
          <button onClick={handleExport} disabled={exporting || selectedKBs.size === 0}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50">
            <Download className="w-4 h-4" />{exporting ? t("settings.exporting") : `${t("settings.exportBtn")} (${selectedKBs.size})`}
          </button>
          <div className="border-t pt-3 mt-2">
            <p className="text-sm text-muted-foreground mb-2">{t("settings.importDesc")}</p>
            <button onClick={handleImport} disabled={importing}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted disabled:opacity-50">
              <Upload className="w-4 h-4" />{importing ? t("settings.importing") : t("settings.importBtn")}
            </button>
          </div>
        </Section>

        {/* Config I/O */}
        <Section id="configIO" title={t("settings.configIO")}>
          <p className="text-sm text-muted-foreground">{t("settings.configIODesc")}</p>
          <div className="flex gap-3">
            <button onClick={handleExportConfig}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90">
              <Download className="w-4 h-4" />{t("settings.exportConfig")}
            </button>
            <button onClick={handleImportConfig}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted">
              <Upload className="w-4 h-4" />{t("settings.importConfig")}
            </button>
          </div>
          {configResult && <p className="text-sm text-muted-foreground">{configResult}</p>}
        </Section>

        {/* Clean Orphans & Clear All */}
        <Section id="cleanup" title={t("settings.clearAll")}>
          <div className="flex gap-3">
            <button onClick={handleCleanOrphans} disabled={cleaningOrphans || !pythonRunning}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted disabled:opacity-50">
              <Trash2 className="w-4 h-4" />{cleaningOrphans ? t("settings.cleaning") : t("settings.cleanOrphans")}
            </button>
            <button onClick={() => setShowClearDialog(true)} disabled={clearing}
              className="flex items-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
              <Trash2 className="w-4 h-4" />{clearing ? t("settings.clearing") : t("settings.clearAllBtn")}
            </button>
          </div>
          {orphanResult && <p className="text-sm text-muted-foreground">{orphanResult}</p>}
          {clearResult && <p className="text-sm text-muted-foreground">{clearResult}</p>}
        </Section>

        <ConfirmDialog open={showClearDialog} title={t("settings.clearAll")} message={t("settings.clearAllConfirm")}
          confirmLabel={t("settings.clearAllConfirmBtn")} cancelLabel={t("kb.cancel")} danger
          onConfirm={handleClearAll} onCancel={() => setShowClearDialog(false)} />
      </div>
    </div>
  );
}