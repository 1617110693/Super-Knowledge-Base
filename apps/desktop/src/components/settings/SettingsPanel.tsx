import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/useSettingsStore";
import type { AppSettings } from "../../types";
import { Save, CheckCircle, Loader2 } from "lucide-react";

export function SettingsPanel() {
  const { settings, loadSettings, saveSettings, pythonRunning, startPython } =
    useSettingsStore();
  const [form, setForm] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleSave = async () => {
    await saveSettings(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const updateField = (field: keyof AppSettings, value: string | number) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const field = (
    label: string,
    key: keyof AppSettings,
    type: string = "text",
    placeholder: string = ""
  ) => (
    <div className="mb-4">
      <label className="block text-sm font-medium mb-1">{label}</label>
      <input
        type={type}
        value={form[key] as string}
        onChange={(e) =>
          updateField(
            key,
            type === "number" ? parseInt(e.target.value) : e.target.value
          )
        }
        placeholder={placeholder}
        className="w-full px-3 py-2 border rounded-md text-sm bg-background"
      />
    </div>
  );

  const select = (
    label: string,
    key: keyof AppSettings,
    options: { value: string; label: string }[]
  ) => (
    <div className="mb-4">
      <label className="block text-sm font-medium mb-1">{label}</label>
      <select
        value={form[key] as string}
        onChange={(e) => updateField(key, e.target.value)}
        className="w-full px-3 py-2 border rounded-md text-sm bg-background"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Settings</h2>
        <button
          onClick={handleSave}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90"
        >
          {saved ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saved ? "Saved" : "Save Settings"}
        </button>
      </div>

      {/* MinerU */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-4 border-b pb-2">
          MinerU Document Parsing
        </h3>
        {field("MinerU Token", "mineru_token", "password", "API管理页面自定创建的token")}
        <p className="text-xs text-muted-foreground -mt-3 mb-4">
          Get your token from{" "}
          <a
            href="https://mineru.net/apiManage/docs"
            target="_blank"
            className="text-primary underline"
          >
            MinerU API Management
          </a>
        </p>
      </section>

      {/* Embedding */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-4 border-b pb-2">
          Embedding Model (OpenAI-compatible)
        </h3>
        {field("API Base URL", "embedding_api_base", "text", "https://api.openai.com")}
        {field("API Key", "embedding_api_key", "password")}
        {field("Model", "embedding_model", "text", "text-embedding-3-small")}
      </section>

      {/* Rerank */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-4 border-b pb-2">
          Rerank Model (OpenAI-compatible)
        </h3>
        {field("API Base URL", "rerank_api_base", "text", "https://api.jina.ai")}
        {field("API Key", "rerank_api_key", "password")}
        {field("Model", "rerank_model", "text", "jina-reranker-v2-base-multilingual")}
      </section>

      {/* LLM */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-4 border-b pb-2">
          LLM for Chat (OpenAI-compatible)
        </h3>
        {field("API Base URL", "llm_api_base", "text", "https://api.openai.com")}
        {field("API Key", "llm_api_key", "password")}
        {field("Model", "llm_model", "text", "gpt-4o-mini")}
      </section>

      {/* Chunking */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-4 border-b pb-2">
          Chunking Configuration
        </h3>
        {select("Strategy", "chunk_strategy", [
          { value: "recursive", label: "Recursive (recommended)" },
          { value: "semantic", label: "Semantic (sentence boundary)" },
          { value: "fixed", label: "Fixed Size" },
        ])}
        {field("Chunk Size", "chunk_size", "number")}
        {field("Chunk Overlap", "chunk_overlap", "number")}
      </section>

      {/* Service */}
      <section className="mb-8">
        <h3 className="text-lg font-semibold mb-4 border-b pb-2">
          Python Backend
        </h3>
        <div className="flex items-center gap-3 mb-4">
          <span
            className={`w-2 h-2 rounded-full ${
              pythonRunning ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <span className="text-sm">
            {pythonRunning ? "Running" : "Stopped"}
          </span>
          {!pythonRunning && (
            <button
              onClick={startPython}
              className="px-3 py-1 bg-primary text-primary-foreground rounded text-xs"
            >
              Start Backend
            </button>
          )}
        </div>
        {field("Port", "python_port", "number")}
      </section>
    </div>
  );
}
