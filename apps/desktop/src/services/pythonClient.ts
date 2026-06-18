/**
 * Python backend HTTP client — communicates with the FastAPI service.
 */
import type { SearchRequest, SearchResult, ChatRequest, ChatMessage } from "../types";

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
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
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
}): Promise<{ doc_id: string; chunk_count: number; status: string }> {
  return pythonFetch("/index", {
    method: "POST",
    body: JSON.stringify(params),
  });
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
