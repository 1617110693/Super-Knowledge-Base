/**
 * Python backend HTTP client — communicates with the FastAPI service.
 */
import type { SearchRequest, SearchAllRequest, SearchResult, ChatRequest, ChatMessage } from "../types";

let _baseUrl: string | null = null;

export async function getBaseUrl(): Promise<string> {
  if (_baseUrl) return _baseUrl;
  const { getPythonBackendUrl } = await import("./tauriBridge");
  _baseUrl = await getPythonBackendUrl();
  return _baseUrl;
}

export async function pythonFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const base = await getBaseUrl();
  const url = `${base}/api/v1${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (e) {
    throw new Error(`Cannot reach backend at ${url}. Is the backend running? (${e})`);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Python backend error (${resp.status}): ${text}`);
  }
  return resp.json();
}

// ── Search ──

export async function search(
  req: SearchRequest
): Promise<{ results: SearchResult[]; total: number; search_time_ms: number }> {
  return pythonFetch("/search", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function searchAll(
  req: SearchAllRequest
): Promise<{ results: SearchResult[]; total: number; search_time_ms: number }> {
  return pythonFetch("/search-all", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function searchDocument(
  req: { kb_id: string; doc_id: string; query: string; search_type?: string; top_k?: number; rerank?: boolean; context_window?: number }
): Promise<{ results: SearchResult[]; total: number; search_time_ms: number }> {
  return pythonFetch("/search-document", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// ── Index Document ──

export async function indexDocument(params: {
  kb_id: string;
  doc_id: string;
  doc_name: string;
  markdown_content: string;
  chunk_config?: {
    strategy?: string;
    chunk_size?: number;
    chunk_overlap?: number;
  };
}): Promise<{ doc_id: string; chunk_count: number; status: string; embedding_model: string; embedding_dim: number }> {
  const result = await pythonFetch<{
    doc_id: string;
    chunk_count: number;
    status: string;
    embedding_model?: string;
    embedding_dim?: number;
  }>("/index", {
    method: "POST",
    body: JSON.stringify(params),
  });
  // Ensure defaults for older backends that don't return these fields
  return {
    ...result,
    embedding_model: result.embedding_model || "",
    embedding_dim: result.embedding_dim || 0,
  };
}

// ── Chat ──

export async function chat(req: ChatRequest): Promise<{
  answer: string;
  sources: SearchResult[];
}> {
  return pythonFetch("/chat", {
    method: "POST",
    body: JSON.stringify({ ...req, stream: false }),
  });
}

export async function chatStream(
  req: ChatRequest,
  onToken: (token: string) => void,
  onSources: (sources: SearchResult[]) => void,
  onDone: () => void,
  onError: (err: string) => void
): Promise<void> {
  const base = await getBaseUrl();
  const url = `${base}/api/v1/chat`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req, stream: true }),
    });

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "token") onToken(parsed.content);
            else if (parsed.type === "sources") onSources(parsed.chunks);
            else if (parsed.type === "done") onDone();
            else if (parsed.type === "error") onError(parsed.content);
          } catch {
            // Skip unparseable lines
          }
        }
      }
    }
    onDone();
  } catch (e) {
    onError(String(e));
  }
}

// ── KB Management ──

export async function copyKbLanceDb(sourceKbId: string, targetKbId: string): Promise<{ status: string }> {
  return pythonFetch("/kb/copy", {
    method: "POST",
    body: JSON.stringify({ source_kb_id: sourceKbId, target_kb_id: targetKbId }),
  });
}

export async function backupKb(kbId: string): Promise<{ kb_id: string; backup_path: string; status: string }> {
  return pythonFetch(`/kb/${kbId}/backup`, { method: "POST" });
}

// ── Health ──

export async function checkHealth(): Promise<boolean> {
  try {
    const base = await getBaseUrl();
    const resp = await fetch(`${base}/api/v1/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

// ── Test Connection ──

export async function testEmbedding(params: {
  api_base: string;
  api_key: string;
  model: string;
}): Promise<{ valid: boolean; dimension?: number; status: string; detail?: string }> {
  return pythonFetch("/config/validate-embedding", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function testRerank(params: {
  api_base: string;
  api_key: string;
  model: string;
}): Promise<{ valid: boolean; format?: string; url?: string; status: string; detail?: string }> {
  return pythonFetch("/config/validate-rerank", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function checkLlamaStatus(): Promise<{ running: boolean; port: number; message: string }> {
  return pythonFetch("/llama-status");
}

export async function cleanOrphans(): Promise<{ cleaned: number; details: string[] }> {
  return pythonFetch("/utils/clean-orphans", { method: "POST" });
}

// ── Get Chunk by Index ──

export interface ChunkByIndex {
  chunk_id: string;
  doc_id: string;
  kb_id: string;
  doc_name: string;
  content: string;
  chunk_index: number;
  page_number: number;
  page_start?: number;
  page_end?: number;
  start_char?: number;
  metadata: Record<string, unknown>;
  prev_exists: boolean;
  next_exists: boolean;
}

export async function getChunkByIndex(params: {
  kb_id: string;
  doc_id: string;
  chunk_index: number;
}): Promise<{ chunk: ChunkByIndex } | { error: string }> {
  return pythonFetch("/get-chunk-by-index", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function getChunkRange(params: {
  kb_id: string;
  doc_id: string;
  start: number;
  end: number;
}): Promise<{ kb_id: string; doc_id: string; chunks: ChunkByIndex[]; start: number; end: number }> {
  return pythonFetch("/get-chunk-range", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// ── Get Chunks by Page ──

export async function getChunksByPage(params: {
  kb_id: string;
  doc_id: string;
  page: number;
}): Promise<{ kb_id: string; doc_id: string; page: number; chunks: ChunkByIndex[]; count: number }> {
  return pythonFetch("/get-chunks-by-page", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
