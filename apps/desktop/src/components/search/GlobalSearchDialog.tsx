import { useState } from "react";
import { searchAll } from "../../services/pythonClient";
import { useI18n } from "../../i18n";
import { Search, Loader2, FileText, X, Globe } from "lucide-react";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import type { SearchResult } from "../../types";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function GlobalSearchDialog({ open, onClose }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const [selectedChunk, setSelectedChunk] = useState<SearchResult | null>(null);

  if (!open) return null;

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(false);
    setError("");
    try {
      const res = await searchAll({ query, search_type: "hybrid", top_k: 10, rerank: true });
      setResults(res.results);
      setElapsed(res.search_time_ms);
      setSearched(true);
    } catch (e) {
      setError(String(e));
      setSearched(true);
    }
    setSearching(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]" onClick={onClose}>
        <div className="bg-card border rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center gap-3 p-4 border-b shrink-0">
            <Globe className="w-5 h-5 text-primary" />
            <h3 className="font-semibold">{t("search.searchAllTitle")}</h3>
            <button onClick={onClose} className="ml-auto p-1 hover:bg-muted rounded-md"><X className="w-5 h-5" /></button>
          </div>

          {/* Search bar */}
          <div className="flex gap-2 p-4 border-b shrink-0">
            <div className="flex-1 relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder={t("search.searchAllPlaceholder")}
                className="w-full pl-9 pr-4 py-2.5 border rounded-lg text-sm bg-background" autoFocus />
            </div>
            <button onClick={handleSearch} disabled={searching || !query.trim()}
              className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50">
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : t("search.searchAllBtn")}
            </button>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto p-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mb-4">{error}</div>
            )}
            {searched && !error && (
              <>
                <p className="text-xs text-muted-foreground mb-3">{results.length} results in {elapsed}ms</p>
                {results.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No results found</p>
                ) : (
                  <div className="space-y-2">
                    {results.map((r) => (
                      <div key={r.chunk_id}
                        className="p-3 border rounded-lg bg-card cursor-pointer hover:border-primary/50 transition-colors"
                        onClick={() => setSelectedChunk(r)}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="w-4 h-4 text-primary shrink-0" />
                            <span className="text-sm font-medium truncate">{r.doc_name}</span>
                          </div>
                          <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-mono shrink-0 ml-2">
                            {(r.score * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap">{r.content.slice(0, 300)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Chunk detail dialog */}
      {selectedChunk && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={() => setSelectedChunk(null)}>
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
    </>
  );
}
