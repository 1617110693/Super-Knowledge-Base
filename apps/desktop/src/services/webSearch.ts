// Web search provider abstraction.
// Supports Tavily and SearXNG providers.

export interface WebSearchConfig {
  provider: "duckduckgo" | "tavily" | "searxng";
  tavilyApiKey?: string;
  searxngBaseUrl?: string;
  maxResults: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

/** Search the web using the configured provider */
export async function searchWeb(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  if (config.provider === "duckduckgo") {
    return searchDuckDuckGo(query, config);
  } else if (config.provider === "tavily") {
    return searchTavily(query, config);
  } else if (config.provider === "searxng") {
    return searchSearxng(query, config);
  }
  throw new Error(`Unknown web search provider: ${config.provider}`);
}

/** Fetch and extract text content from a URL */
export async function fetchWebContent(url: string): Promise<string> {
  // Try using a free text extraction service first
  try {
    const resp = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "Accept": "text/markdown" },
    });
    if (resp.ok) {
      const text = await resp.text();
      return text.slice(0, 30000); // Limit to 30K chars
    }
  } catch { /* fall through to direct fetch */ }

  // Fallback: direct fetch
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const html = await resp.text();
  return extractText(html).slice(0, 30000);
}

// ── Tavily ──────────────────────────────────────────────────────────────

async function searchTavily(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  if (!config.tavilyApiKey) throw new Error("Tavily API key not configured");
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      search_depth: "basic",
      max_results: Math.min(config.maxResults || 5, 10),
      include_answer: false,
    }),
  });
  if (!resp.ok) throw new Error(`Tavily search failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return (data.results || []).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    content: r.content || "",
    score: r.score,
  }));
}

// ── SearXNG ─────────────────────────────────────────────────────────────

async function searchSearxng(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  const base = (config.searxngBaseUrl || "http://localhost:8080").replace(/\/$/, "");
  const resp = await fetch(`${base}/search?format=json&q=${encodeURIComponent(query)}`);
  if (!resp.ok) throw new Error(`SearXNG search failed: ${resp.status}`);
  const data = await resp.json();
  return (data.results || []).slice(0, config.maxResults || 5).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    content: r.content || r.snippet || "",
    score: r.score,
  }));
}

// ── DuckDuckGo (free, no API key) ───────────────────────────────────────

async function searchDuckDuckGo(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  // Use DuckDuckGo Lite for simple HTML parsing
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!resp.ok) throw new Error(`DuckDuckGo search failed: ${resp.status}`);
  const html = await resp.text();

  // Parse the lite HTML results
  const results: WebSearchResult[] = [];
  // Match result rows: <a href="url" ...>title</a> followed by <span class="link-text">url</span> and snippet
  const rowRegex = /<a\s+rel="nofollow"\s+href="([^"]+)"[^>]*>([^<]+)<\/a>\s*<span\s+class="link-text">[^<]*<\/span>\s*(?:<span[^>]*>[^<]*<\/span>\s*)?<span\s+class="snippet">([^<]*)<\/span>/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    results.push({
      title: decodeHtmlEntities(match[2].trim()),
      url: match[1].trim(),
      content: decodeHtmlEntities(match[3].trim()),
    });
    if (results.length >= (config.maxResults || 5)) break;
  }

  // Fallback: try alternative parsing if regex didn't match
  if (results.length === 0) {
    const altRegex = /<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*class="result-link"[^>]*>([^<]+)<\/a>[\s\S]*?<td\s+class="result-snippet"[^>]*>([^<]+)</gi;
    let altMatch;
    while ((altMatch = altRegex.exec(html)) !== null) {
      results.push({
        title: decodeHtmlEntities(altMatch[2].trim()),
        url: altMatch[1].trim(),
        content: decodeHtmlEntities(altMatch[3].trim()),
      });
      if (results.length >= (config.maxResults || 5)) break;
    }
  }

  return results;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ── Text extraction ─────────────────────────────────────────────────────

function extractText(html: string): string {
  // Remove scripts, styles, and HTML tags
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
