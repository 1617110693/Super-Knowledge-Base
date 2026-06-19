import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useI18n } from "../../i18n";
import { configureClaudeMCP } from "../../services/tauriBridge";
import { testEmbedding, testRerank } from "../../services/pythonClient";
import type { AppSettings } from "../../types";
import { Save, CheckCircle, Loader2, Terminal, Check, X, FolderOpen, FlaskConical, Copy, ClipboardCheck } from "lucide-react";

export function SettingsPanel() {
  const { t } = useI18n();
  const { settings, loadSettings, saveSettings, pythonRunning, startPython } = useSettingsStore();
  const [form, setForm] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);
  const [claudeStatus, setClaudeStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [copiedMCP, setCopiedMCP] = useState(false);

  const handleCopyMCPConfig = async () => {
    const config = {
      mcpServers: {
        "local-knowledge-base": {
          command: "uv",
          args: ["run", "--directory", "D:/AI/mcp/local-knowledge-base/apps/mcp-server", "local-kb-mcp"],
          env: {
            KNOWLEDGE_BASE_DATA_DIR: form.data_dir || "%USERPROFILE%/.local-knowledge-base",
          },
        },
      },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      setCopiedMCP(true);
      setTimeout(() => setCopiedMCP(false), 2000);
    } catch {
      // clipboard may not be available
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

  const update = (field: keyof AppSettings, value: string | number) =>
    setForm((p) => ({ ...p, [field]: value }));

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">{t("settings.title")}</h2>
        <button onClick={handleSave}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90">
          {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saved ? t("settings.saved") : t("settings.save")}
        </button>
      </div>

      {/* General */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.general")}</h3>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">{t("settings.dataDir")}</label>
          <div className="flex gap-2">
            <input type="text" value={form.data_dir}
              onChange={(e) => update("data_dir", e.target.value)}
              placeholder="~/.local-knowledge-base"
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
            setTestingEmbedding(true);
            setTestEmbeddingResult(null);
            try {
              const r = await testEmbedding({
                api_base: form.embedding_api_base,
                api_key: form.embedding_api_key,
                model: form.embedding_model,
              });
              setTestEmbeddingResult({
                ok: r.valid,
                msg: r.valid
                  ? t("settings.testSuccess", { dim: String(r.dimension ?? "?") })
                  : `${t("settings.testFailed")}: ${r.detail || r.status}`,
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
          <div className={`mt-2 p-2.5 rounded-md text-xs flex items-start gap-2 ${
            testEmbeddingResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"
          }`}>
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
            setTestingRerank(true);
            setTestRerankResult(null);
            try {
              const r = await testRerank({
                api_base: form.rerank_api_base,
                api_key: form.rerank_api_key,
                model: form.rerank_model,
              });
              setTestRerankResult({
                ok: r.valid,
                msg: r.valid
                  ? t("settings.testSuccessRerank")
                  : `${t("settings.testFailed")}: ${r.detail || r.status}`,
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
          <div className={`mt-2 p-2.5 rounded-md text-xs flex items-start gap-2 ${
            testRerankResult.ok ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"
          }`}>
            {testRerankResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
            <span className="whitespace-pre-wrap">{testRerankResult.msg}</span>
          </div>
        )}
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

      {/* Python Backend */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-4 border-b pb-2">{t("settings.python")}</h3>
        <div className="flex items-center gap-3 mb-4">
          <span className={`w-2 h-2 rounded-full ${pythonRunning ? "bg-green-500" : "bg-red-500"}`} />
          <span className="text-sm">{pythonRunning ? t("settings.running") : t("settings.stopped")}</span>
          {!pythonRunning && (
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
              setConfiguring(true);
              setClaudeStatus(null);
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
            {configuring ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Terminal className="w-4 h-4" />
            )}
            {t("settings.configureClaude")}
          </button>
          <button
            onClick={handleCopyMCPConfig}
            className="flex items-center gap-2 px-4 py-2.5 border rounded-lg text-sm font-medium hover:bg-muted transition-colors"
          >
            {copiedMCP ? (
              <ClipboardCheck className="w-4 h-4 text-green-500" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
            {copiedMCP ? t("settings.saved") : t("settings.copyMCPConfig")}
          </button>
        </div>
        {claudeStatus && (
          <div className={`mt-3 p-3 rounded-lg text-sm flex items-start gap-2 ${
            claudeStatus.success ? "bg-green-50 border border-green-200 text-green-800" : "bg-red-50 border border-red-200 text-red-700"
          }`}>
            {claudeStatus.success ? <Check className="w-4 h-4 mt-0.5 shrink-0" /> : <X className="w-4 h-4 mt-0.5 shrink-0" />}
            <p className="whitespace-pre-wrap">{claudeStatus.message}</p>
          </div>
        )}
      </section>
    </div>
  );
}
