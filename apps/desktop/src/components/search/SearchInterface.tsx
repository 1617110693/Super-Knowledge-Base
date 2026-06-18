import { useState } from "react";
import { useParams } from "react-router-dom";
import { search as searchAPI } from "../../services/pythonClient";
import { Search, Loader2, FileText, ChevronDown } from "lucide-react";
import type { SearchResult } from "../../types";

export function SearchInterface() {
  const { kbId } = useParams<{ kbId: string }>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchType, setSearchType] = useState<"hybrid" | "vector" | "fts">("hybrid");
  const [rerank, setRerank] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");

  const handleSearch = async () => {
    if (!query.trim() || !kbId) return;
    setSearching(true);
    setError("");
    try {
      const res = await searchAPI({
        kb_id: kbId,
        query,
        search_type: searchType,
        top_k: 10,
        rerank,
      });
      setResults(res.results);
      setElapsed(res.search_time_ms);
    } catch (e) {
      setError(String(e));
    }
    setSearching(false);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Search</h2>

      {/* Search bar */}
      <div className="flex gap-2 mb-4">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search your knowledge base..."
            className="w-full pl-9 pr-4 py-2.5 border rounded-lg text-sm bg-background"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {searching ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            "Search"
          )}
        </button>
      </div>

      {/* Options */}
      <div className="flex gap-4 mb-6 text-sm">
        <select
          value={searchType}
          onChange={(e) => setSearchType(e.target.value as any)}
          className="px-3 py-1.5 border rounded-md bg-background text-sm"
        >
          <option value="hybrid">Hybrid Search</option>
          <option value="vector">Vector (Semantic)</option>
          <option value="fts">Keyword (FTS)</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={rerank}
            onChange={(e) => setRerank(e.target.checked)}
            className="rounded"
          />
          Rerank results
        </label>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <p className="text-xs text-muted-foreground mb-3">
          {results.length} results in {elapsed}ms
        </p>
      )}

      <div className="space-y-3">
        {results.map((r) => (
          <div key={r.chunk_id} className="p-4 border rounded-lg bg-card">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">{r.doc_name}</span>
              </div>
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-mono">
                {(r.score * 100).toFixed(0)}%
              </span>
            </div>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-5">
              {r.content}
            </p>
            {r.metadata?.page && (
              <p className="text-xs text-muted-foreground mt-2">
                Page {r.metadata.page}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
