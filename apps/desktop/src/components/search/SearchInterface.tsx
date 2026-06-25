import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { search as searchAPI } from "../../services/pythonClient";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useI18n } from "../../i18n";
import { Search, Loader2, FileText, ArrowLeft, X } from "lucide-react";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import type { SearchResult } from "../../types";

export function SearchInterface() {
  const { kbId } = useParams<{ kbId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { settings } = useSettingsStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchType, setSearchType] = useState<"hybrid" | "vector" | "fts">("hybrid");
  const [rerank, setRerank] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [selectedChunk, setSelectedChunk] = useState<SearchResult | null>(null);

  const handleSearch = async () => {
    if (!query.trim() || !kbId) return;
    setSearching(true); setError("");
    try {
      const res = await searchAPI({ kb_id: kbId, query, search_type: searchType, top_k: 10, rerank });
      setResults(res.results); setElapsed(res.search_time_ms);
    } catch (e) { setError(String(e)); }
    setSearching(false);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <button
        onClick={() => navigate(`/kb/${kbId}`)}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>
      <h2 className="text-2xl font-bold mb-6">{t("search.title")}</h2>

      <div className="flex gap-2 mb-4">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder={t("search.placeholder")}
            className="w-full pl-9 pr-4 py-2.5 border rounded-lg text-sm bg-background" />
        </div>
        <button onClick={handleSearch} disabled={searching || !query.trim()}
          className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50">
          {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : t("search.searchBtn")}
        </button>
      </div>

      <div className="flex gap-4 mb-6 text-sm">
        <select value={searchType} onChange={(e) => setSearchType(e.target.value as any)} className="px-3 py-1.5 border rounded-md bg-background text-sm">
          <option value="hybrid">{t("search.hybrid")}</option>
          <option value="vector">{t("search.vector")}</option>
          <option value="fts">{t("search.fts")}</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} className="rounded" />
          {t("search.rerank")}
        </label>
        {rerank && settings.rerank_model && (
          <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded self-center">{settings.rerank_model}</span>
        )}
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mb-4">{error}</div>}

      {results.length > 0 && (
        <p className="text-xs text-muted-foreground mb-3">{t("search.results", { count: results.length, time: elapsed })}</p>
      )}

      <div className="space-y-3">
        {results.map((r) => (
          <div
            key={r.chunk_id}
            className="p-4 border rounded-lg bg-card cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => setSelectedChunk(r)}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">{r.doc_name}</span>
              </div>
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-mono">
                {(r.score * 100).toFixed(0)}%
              </span>
            </div>
            <div className="max-h-32 overflow-hidden relative">
              <MarkdownRenderer className="prose prose-sm max-w-none dark:prose-invert text-muted-foreground">
                {r.content}
              </MarkdownRenderer>
              <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent pointer-events-none" />
            </div>
            {r.metadata?.page && (
              <p className="text-xs text-muted-foreground mt-2">{t("search.page")} {r.metadata.page}</p>
            )}
          </div>
        ))}
      </div>

      {/* Chunk detail dialog */}
      {selectedChunk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSelectedChunk(null)}>
          <div className="bg-card border rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <FileText className="w-5 h-5 text-primary shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm truncate">{selectedChunk.doc_name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {selectedChunk.metadata?.page != null && <span>{t("search.page")} {selectedChunk.metadata.page} · </span>}
                    {selectedChunk.metadata?.chunk_index != null && <span>{t("search.chunkIndex", { index: selectedChunk.metadata.chunk_index })} · </span>}
                    <span className="font-mono text-primary">{(selectedChunk.score * 100).toFixed(1)}%</span>
                  </p>
                </div>
              </div>
              <button onClick={() => setSelectedChunk(null)} className="p-1 hover:bg-muted rounded-md shrink-0">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              <MarkdownRenderer className="prose prose-sm max-w-none dark:prose-invert">
                {selectedChunk.content}
              </MarkdownRenderer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
