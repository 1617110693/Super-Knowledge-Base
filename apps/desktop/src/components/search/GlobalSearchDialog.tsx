import { useState, useRef } from "react";
import { searchAll, getChunkByIndex } from "../../services/pythonClient";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useI18n } from "../../i18n";
import { Search, Loader2, FileText, X, Globe, ChevronDown, ChevronUp } from "lucide-react";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { ErrorDialog } from "../common/ErrorDialog";
import { ChunkDetailDialog, type ChunkInfo } from "../common/ChunkDetailDialog";
import type { SearchResult, NeighborChunk } from "../../types";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function GlobalSearchDialog({ open, onClose }: Props) {
  const { t } = useI18n();
  const { settings } = useSettingsStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchType, setSearchType] = useState<"hybrid" | "vector" | "fts">("hybrid");
  const [rerank, setRerank] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const [selectedChunk, setSelectedChunk] = useState<SearchResult | null>(null);
  const [selectedNeighbor, setSelectedNeighbor] = useState<NeighborChunk | null>(null);
  const [expandedContext, setExpandedContext] = useState<Set<string>>(new Set());

  if (!open) return null;

  const navigateAdjacentChunk = (chunk: SearchResult, delta: number) => {
    const ci = chunk.metadata?.chunk_index as number | undefined;
    if (ci == null || !chunk.doc_id || !chunk.kb_id) return;
    getChunkByIndex({ kb_id: chunk.kb_id, doc_id: chunk.doc_id, chunk_index: ci + delta }).then(res => {
      if ("error" in res) return;
      const c = res.chunk;
      setSelectedChunk({
        content: c.content, doc_name: c.doc_name, doc_id: c.doc_id, kb_id: c.kb_id,
        score: 0, metadata: { chunk_index: c.chunk_index, page: c.page_number },
      } as SearchResult);
    }).catch(() => {});
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(false);
    setError("");
    setExpandedContext(new Set());
    try {
      const res = await searchAll({ query, search_type: searchType, top_k: 10, rerank, context_window: 0 });
      setResults(res.results);
      setElapsed(res.search_time_ms);
      setSearched(true);
    } catch (e) {
      const msg = String(e);
      setError(msg.includes("Cannot reach backend") ? t("error.backendUnreachable") + "\n\n" + msg : msg);
      setSearched(true);
    }
    setSearching(false);
  };

  const toggleContext = (chunkId: string) => {
    setExpandedContext((prev) => {
      const next = new Set(prev);
      if (next.has(chunkId)) next.delete(chunkId);
      else next.add(chunkId);
      return next;
    });
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
          <div className="flex gap-2 p-4 pb-2 border-b shrink-0">
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

          {/* Search controls */}
          <div className="flex gap-3 px-4 py-2 border-b shrink-0 text-xs flex-wrap items-center">
            <select value={searchType} onChange={(e) => setSearchType(e.target.value as any)} className="px-2 py-1 border rounded-md bg-background text-xs">
              <option value="hybrid">{t("search.hybrid")}</option>
              <option value="vector">{t("search.vector")}</option>
              <option value="fts">{t("search.fts")}</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} className="rounded" />
              {t("search.rerank")}
            </label>
            {rerank && (settings.use_local_rerank ? (settings.local_rerank_model || "local").replace(/\.gguf$/i, "").split(/[/\\]/).pop() : settings.rerank_model) && (
              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{settings.use_local_rerank ? (settings.local_rerank_model || "local").replace(/\.gguf$/i, "").split(/[/\\]/).pop() : settings.rerank_model}</span>
            )}
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto p-4">
            <ErrorDialog title={t("error.search")} error={error} onClose={() => setError("")} />
            {searched && !error && (
              <>
                <p className="text-xs text-muted-foreground mb-3">{results.length} results in {elapsed}ms</p>
                {results.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No results found</p>
                ) : (
                  <div className="space-y-2">
                    {results.map((r) => (
                      <div key={r.chunk_id} className="border rounded-lg bg-card hover:border-primary/50 transition-colors">
                        <div className="p-3 cursor-pointer" onClick={() => setSelectedChunk(r)}>
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
                          {((r.metadata?.page ?? 0) > 0 || r.metadata?.chunk_index != null) && (
                            <p className="text-[10px] text-muted-foreground mt-1">
                              {(r.metadata?.page ?? 0) > 0 && <span>{t("search.page")} {r.metadata.page} · </span>}
                              {r.metadata?.chunk_index != null && <span>Chunk #{r.metadata.chunk_index}</span>}
                            </p>
                          )}
                        </div>

                        {/* Neighbor chunks */}
                        {r.context && (r.context.prev.length > 0 || r.context.next.length > 0) && (
                          <div className="border-t px-3 py-1.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleContext(r.chunk_id); }}
                              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {expandedContext.has(r.chunk_id) ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              {t("search.neighborChunks") || "Neighboring chunks"} ({r.context.prev.length + r.context.next.length})
                            </button>
                            {expandedContext.has(r.chunk_id) && (
                              <div className="mt-1.5 space-y-1.5">
                                {r.context.prev.map((nc: NeighborChunk, i: number) => (
                                  <div key={nc.chunk_id || `prev-${i}`}
                                    className="p-2 rounded bg-muted/50 border border-border/30 text-[11px] cursor-pointer hover:border-primary/40 transition-colors"
                                    onClick={() => setSelectedNeighbor(nc)}>
                                    <span className="font-medium text-muted-foreground">{t("search.prevChunk") || "Prev"}</span>
                                    <span className="text-muted-foreground/60 ml-1">#{nc.chunk_index}</span>
                                    {nc.page_number != null && nc.page_number > 0 && <span className="text-muted-foreground/60 ml-1">p.{nc.page_number}</span>}
                                    <p className="text-muted-foreground line-clamp-2 mt-0.5">{nc.content.slice(0, 300)}</p>
                                  </div>
                                ))}
                                {r.context.next.map((nc: NeighborChunk, i: number) => (
                                  <div key={nc.chunk_id || `next-${i}`}
                                    className="p-2 rounded bg-muted/50 border border-border/30 text-[11px] cursor-pointer hover:border-primary/40 transition-colors"
                                    onClick={() => setSelectedNeighbor(nc)}>
                                    <span className="font-medium text-muted-foreground">{t("search.nextChunk") || "Next"}</span>
                                    <span className="text-muted-foreground/60 ml-1">#{nc.chunk_index}</span>
                                    {nc.page_number != null && nc.page_number > 0 && <span className="text-muted-foreground/60 ml-1">p.{nc.page_number}</span>}
                                    <p className="text-muted-foreground line-clamp-2 mt-0.5">{nc.content.slice(0, 300)}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
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
        <ChunkDetailDialog
          chunk={{
            content: selectedChunk.content,
            doc_name: selectedChunk.doc_name,
            doc_id: selectedChunk.doc_id,
            kb_id: selectedChunk.kb_id,
            chunk_index: selectedChunk.metadata?.chunk_index as number | undefined,
            page_number: selectedChunk.metadata?.page,
            score: selectedChunk.score,
          }}
          onClose={() => setSelectedChunk(null)}
          onPrev={selectedChunk.metadata?.chunk_index != null && selectedChunk.metadata.chunk_index > 0
            ? () => navigateAdjacentChunk(selectedChunk, -1) : undefined}
          onNext={selectedChunk.metadata?.chunk_index != null && selectedChunk.doc_id
            ? () => navigateAdjacentChunk(selectedChunk, 1) : undefined}
          hasPrev={!!(selectedChunk.metadata?.chunk_index != null && selectedChunk.metadata.chunk_index > 0)}
          hasNext={!!(selectedChunk.metadata?.chunk_index != null && selectedChunk.doc_id)}
        />
      )}

      {/* Neighbor chunk detail dialog */}
      {selectedNeighbor && (
        <ChunkDetailDialog
          chunk={{
            content: selectedNeighbor.content,
            chunk_index: selectedNeighbor.chunk_index,
            page_number: selectedNeighbor.page_number,
            doc_id: (selectedNeighbor as any).metadata?.doc_id,
            kb_id: (selectedNeighbor as any).metadata?.kb_id,
            doc_name: (selectedNeighbor as any).metadata?.doc_name,
          }}
          title="Neighbor Chunk"
          onClose={() => setSelectedNeighbor(null)}
        />
      )}
    </>
  );
}
