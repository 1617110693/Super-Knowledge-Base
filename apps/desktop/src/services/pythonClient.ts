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

export interface IndexProgress {
  stage: string;
  current: number;
  total: number;
  percent: number;
  done: boolean;
  chunk_count?: number;
  embedding_model?: string;
  embedding_dim?: number;
  error?: string;
  vlm_pending?: number;
  vlm_total?: number;
  vlm_status?: string;
  vlm_current?: number;
  vlm_error?: string;
}

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
}): Promise<{ task_id: string }> {
  return pythonFetch<{ task_id: string }>("/index", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function pollIndexProgress(taskId: string): Promise<IndexProgress> {
  return pythonFetch<IndexProgress>(`/index/progress/${taskId}`);
}

export async function waitForIndex(
  taskId: string,
  onProgress?: (p: IndexProgress) => void,
  timeoutMs: number = 30 * 60 * 1000,  // 30-minute timeout
): Promise<IndexProgress> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await pollIndexProgress(taskId);
    onProgress?.(p);
    if (p.done) {
      if (p.error) throw new Error(p.error);
      return p;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Indexing timed out after ${timeoutMs / 1000}s`);
}

export async function cancelIndexTask(taskId: string): Promise<{ status: string }> {
  return pythonFetch<{ status: string }>(`/index/task/${taskId}`, { method: "DELETE" });
}

export interface VlmStatus {
  vlm_status: string;
  vlm_current: number;
  vlm_total: number;
  vlm_pending: number;
  vlm_error: string;
  chunk_count: number;
}

export async function pollVlmStatus(taskId: string): Promise<VlmStatus> {
  return pythonFetch<VlmStatus>(`/index/vlm-status/${taskId}`);
}

export async function waitForVlmComplete(
  taskId: string,
  onProgress?: (v: VlmStatus) => void,
  timeoutMs = 30 * 60 * 1000,
): Promise<VlmStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await pollVlmStatus(taskId);
    onProgress?.(v);
    if (v.vlm_status === "done" || v.vlm_status === "error") return v;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`VLM processing timed out after ${timeoutMs / 1000}s`);
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

export async function testLLM(params: {
  api_base: string;
  api_key: string;
  model: string;
}): Promise<{ valid: boolean; status: string; detail?: string }> {
  return pythonFetch("/config/validate-llm", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function testVLM(params: {
  api_base: string;
  api_key: string;
  model: string;
}): Promise<{ valid: boolean; status: string; detail?: string }> {
  return pythonFetch("/config/validate-vlm", {
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

export interface FillProgress {
  stage: string;
  current: number;
  total: number;
  done: boolean;
  current_name?: string;
  filled?: number;
  failed?: number;
  failed_details?: { name: string; error: string }[];
  message?: string;
}

export async function fillMissingImages(kbId: string, docId: string): Promise<{
  task_id: string; total: number; done: boolean; message?: string;
}> {
  return pythonFetch("/images/fill-missing", {
    method: "POST",
    body: JSON.stringify({ kb_id: kbId, doc_id: docId, filename: "_" }),
  });
}

export async function pollFillProgress(taskId: string): Promise<FillProgress> {
  return pythonFetch(`/images/fill-missing/progress/${taskId}`);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await pythonFetch("/get-chunk-range", {
      method: "POST",
      body: JSON.stringify(params),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
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
