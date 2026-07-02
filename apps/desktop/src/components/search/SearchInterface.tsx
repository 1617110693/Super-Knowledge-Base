import { useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { search as searchAPI, getChunkByIndex, type ChunkByIndex } from "../../services/pythonClient";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useI18n } from "../../i18n";
import { ErrorDialog } from "../common/ErrorDialog";
import { ChunkDetailDialog } from "../common/ChunkDetailDialog";
import { Search, Loader2, FileText, ArrowLeft, X, ChevronDown, ChevronUp, Hash } from "lucide-react";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import type { SearchResult, NeighborChunk } from "../../types";

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
  const [selectedNeighbor, setSelectedNeighbor] = useState<NeighborChunk | null>(null);
  const [expandedContext, setExpandedContext] = useState<Set<string>>(new Set());

  // Chunk index lookup (shown after search results appear)
  const [chunkLookupIndex, setChunkLookupIndex] = useState("");
  const [chunkLookupDocId, setChunkLookupDocId] = useState("");
  const [chunkLookupResult, setChunkLookupResult] = useState<ChunkByIndex | null>(null);
  const [chunkLookupError, setChunkLookupError] = useState("");
  const [chunkLookupLoading, setChunkLookupLoading] = useState(false);
  const [lookupDialogOpen, setLookupDialogOpen] = useState(false);

  // Derive unique docs from current results for the dropdown
  const uniqueDocs = Array.from(
    new Map(results.map((r) => [r.doc_id, { doc_id: r.doc_id, doc_name: r.doc_name }])).values()
  );

  // Navigate to adjacent chunk by chunk_index (not by search result order)
  const navigateAdjacentChunk = (chunk: SearchResult, delta: number, kb: string,
    setFn: (c: SearchResult | null) => void, errFn: (e: string) => void) => {
    const ci = chunk.metadata?.chunk_index as number | undefined;
    if (ci == null || !chunk.doc_id) return;
    getChunkByIndex({ kb_id: kb, doc_id: chunk.doc_id, chunk_index: ci + delta }).then(res => {
      if ("error" in res) return; // boundary, silently skip
      const c = res.chunk;
      setFn({
        content: c.content, doc_name: c.doc_name, doc_id: c.doc_id, kb_id: c.kb_id,
        score: 0, metadata: { chunk_index: c.chunk_index, page: c.page_number },
      } as SearchResult);
    }).catch(() => {});
  };

  const handleChunkLookup = async () => {
    if (!kbId || !chunkLookupIndex.trim() || !chunkLookupDocId) return;
    setChunkLookupLoading(true); setChunkLookupError(""); setChunkLookupResult(null);
    try {
      const res = await getChunkByIndex({ kb_id: kbId, doc_id: chunkLookupDocId, chunk_index: Number(chunkLookupIndex) });
      if ("error" in res) {
        setChunkLookupError(res.error);
      } else {
        setChunkLookupResult(res.chunk);
      }
    } catch (e) { setChunkLookupError(String(e)); }
    setChunkLookupLoading(false);
  };

  const handleSearch = async () => {
    if (!query.trim() || !kbId) return;
    setSearching(true); setError(""); setExpandedContext(new Set()); setChunkLookupResult(null); setChunkLookupError("");
    try {
      const res = await searchAPI({ kb_id: kbId, query, search_type: searchType, top_k: 10, rerank, context_window: 0 });
      setResults(res.results); setElapsed(res.search_time_ms);
    } catch (e) {
      const msg = String(e);
      setError(msg.includes("Cannot reach backend") ? t("error.backendUnreachable") + "\n\n" + msg : msg);
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

      <div className="flex gap-4 mb-6 text-sm flex-wrap items-center">
        <select value={searchType} onChange={(e) => setSearchType(e.target.value as any)} className="px-3 py-1.5 border rounded-md bg-background text-sm">
          <option value="hybrid">{t("search.hybrid")}</option>
          <option value="vector">{t("search.vector")}</option>
          <option value="fts">{t("search.fts")}</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} className="rounded" />
          {t("search.rerank")}
        </label>
        {rerank && (settings.use_local_rerank ? (settings.local_rerank_model || "local").replace(/\.gguf$/i, "").split(/[/\\]/).pop() : settings.rerank_model) && (
          <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded self-center">{settings.use_local_rerank ? (settings.local_rerank_model || "local").replace(/\.gguf$/i, "").split(/[/\\]/).pop() : settings.rerank_model}</span>
        )}
      </div>

      <ErrorDialog title={t("error.search")} error={error} onClose={() => setError("")} />

      {results.length > 0 && (
        <p className="text-xs text-muted-foreground mb-3">{t("search.results", { count: results.length, time: elapsed })}</p>
      )}

      {/* Chunk index lookup — shown only after results appear */}
      {results.length > 0 && (
        <details className="mb-4 text-sm border rounded-lg bg-card/50">
          <summary className="px-3 py-2 cursor-pointer text-muted-foreground hover:text-foreground select-none flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5" />
            <span>{t("search.jumpToChunk") || "Jump to chunk"}</span>
          </summary>
          <div className="px-3 pb-3 space-y-2">
            <div className="flex gap-2 flex-wrap items-end">
              <label className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">{t("search.chunkIndexLabel") || "Chunk index"}</span>
                <input type="number" min="0" value={chunkLookupIndex}
                  onChange={(e) => setChunkLookupIndex(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleChunkLookup()}
                  placeholder="0" className="w-24 px-2 py-1.5 border rounded-md text-xs bg-background" />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">{t("search.selectDoc") || "Document"}</span>
                <select value={chunkLookupDocId}
                  onChange={(e) => setChunkLookupDocId(e.target.value)}
                  className="px-2 py-1.5 border rounded-md text-xs bg-background max-w-[220px] truncate">
                  <option value="">{t("search.selectDocPlaceholder") || "-- select --"}</option>
                  {uniqueDocs.map((d) => (
                    <option key={d.doc_id} value={d.doc_id}>{d.doc_name}</option>
                  ))}
                </select>
              </label>
              <button onClick={handleChunkLookup} disabled={chunkLookupLoading || !chunkLookupIndex.trim() || !chunkLookupDocId}
                className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:opacity-90 disabled:opacity-50">
                {chunkLookupLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (t("search.lookupBtn") || "Lookup")}
              </button>
            </div>
            {chunkLookupError && <p className="text-xs text-red-600">{chunkLookupError}</p>}
            {chunkLookupResult && (
              <div className="p-3 border rounded-lg bg-card cursor-pointer hover:border-primary/50 transition-colors text-xs"
                onClick={() => setLookupDialogOpen(true)}>
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="font-medium truncate">{chunkLookupResult.doc_name}</span>
                  <span className="text-[10px] bg-muted px-1 rounded shrink-0">chunk #{chunkLookupResult.chunk_index}</span>
                  {(chunkLookupResult.page_number ?? 0) > 0 && <span className="text-[10px] bg-muted px-1 rounded shrink-0">p.{chunkLookupResult.page_number}</span>}
                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                    {chunkLookupResult.prev_exists ? "← prev" : "← start"} · {chunkLookupResult.next_exists ? "next →" : "end →"}
                  </span>
                </div>
                <p className="text-muted-foreground line-clamp-2">{chunkLookupResult.content.slice(0, 200)}</p>
              </div>
            )}
          </div>
        </details>
      )}

      <div className="space-y-3">
        {results.map((r) => (
          <div
            key={r.chunk_id}
            className="p-4 border rounded-lg bg-card hover:border-primary/50 transition-colors"
          >
            <div className="flex items-center justify-between mb-2 cursor-pointer" onClick={() => setSelectedChunk(r)}>
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">{r.doc_name}</span>
              </div>
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-mono">
                {(r.score * 100).toFixed(0)}%
              </span>
            </div>
            {/* Matched chunk content */}
            <div className="max-h-32 overflow-hidden relative cursor-pointer" onClick={() => setSelectedChunk(r)}>
              <MarkdownRenderer className="prose prose-sm max-w-none dark:prose-invert text-muted-foreground">
                {r.content}
              </MarkdownRenderer>
              <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent pointer-events-none" />
            </div>
            <p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-2">
              {r.metadata?.chunk_index != null && <span>Chunk #{r.metadata.chunk_index}</span>}
              {(r.metadata?.page ?? 0) > 0 && <span>· {t("search.page")} {r.metadata.page}</span>}
            </p>

            {/* Neighbor chunks (context window) */}
            {r.context && (r.context.prev.length > 0 || r.context.next.length > 0) && (
              <div className="mt-2 border-t pt-2">
                <button
                  onClick={(e) => { e.stopPropagation(); toggleContext(r.chunk_id); }}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {expandedContext.has(r.chunk_id) ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  {t("search.neighborChunks") || "Neighboring chunks"} ({r.context.prev.length + r.context.next.length})
                </button>
                {expandedContext.has(r.chunk_id) && (
                  <div className="mt-2 space-y-2">
                    {r.context.prev.map((nc: NeighborChunk, i: number) => (
                      <NeighborChunkCard key={nc.chunk_id || `prev-${i}`} chunk={nc} label={t("search.prevChunk") || "Previous"} onClick={() => setSelectedNeighbor(nc)} />
                    ))}
                    {r.context.next.map((nc: NeighborChunk, i: number) => (
                      <NeighborChunkCard key={nc.chunk_id || `next-${i}`} chunk={nc} label={t("search.nextChunk") || "Next"} onClick={() => setSelectedNeighbor(nc)} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
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
            ? () => navigateAdjacentChunk(selectedChunk, -1, kbId!, setSelectedChunk, setError) : undefined}
          onNext={selectedChunk.metadata?.chunk_index != null && selectedChunk.doc_id
            ? () => navigateAdjacentChunk(selectedChunk, 1, kbId!, setSelectedChunk, setError) : undefined}
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
            doc_id: (selectedNeighbor.metadata as any)?.doc_id,
            kb_id: (selectedNeighbor.metadata as any)?.kb_id,
            doc_name: (selectedNeighbor.metadata as any)?.doc_name,
          }}
          title={t("search.neighborChunkDetail") || "Neighbor Chunk"}
          onClose={() => setSelectedNeighbor(null)}
        />
      )}

      {/* Lookup result detail dialog */}
      {lookupDialogOpen && chunkLookupResult && (
        <ChunkDetailDialog
          chunk={{
            content: chunkLookupResult.content,
            doc_name: chunkLookupResult.doc_name,
            doc_id: chunkLookupResult.doc_id,
            kb_id: chunkLookupResult.kb_id,
            chunk_index: chunkLookupResult.chunk_index,
            page_number: chunkLookupResult.page_number,
          }}
          onClose={() => setLookupDialogOpen(false)}
        />
      )}
    </div>
  );
}

/** Small card showing a neighboring chunk — clickable to open detail dialog. */
function NeighborChunkCard({ chunk, label, onClick }: { chunk: NeighborChunk; label: string; onClick: () => void }) {
  return (
    <div className="p-2.5 rounded-md bg-muted/50 border border-border/50 text-xs cursor-pointer hover:border-primary/40 transition-colors" onClick={onClick}>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="text-[10px] bg-muted px-1 rounded">chunk #{chunk.chunk_index}</span>
        {chunk.page_number != null && chunk.page_number > 0 && (
          <span className="text-[10px] bg-muted px-1 rounded">p.{chunk.page_number}</span>
        )}
      </div>
      <div className="text-muted-foreground line-clamp-4">
        <MarkdownRenderer className="prose prose-xs max-w-none dark:prose-invert">
          {chunk.content}
        </MarkdownRenderer>
      </div>
    </div>
  );
}
