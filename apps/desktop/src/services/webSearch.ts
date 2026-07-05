// Web search provider abstraction.
// Supports DuckDuckGo (free), Tavily, and SearXNG providers.
//
// All HTTP requests go through Tauri's HTTP plugin (`@tauri-apps/plugin-http`)
// instead of the browser's `fetch`. Reasons:
//   1. CORS — DuckDuckGo / Tavily don't return Access-Control-Allow-Origin for
//      arbitrary origins, so the webview's fetch rejects them ("Failed to fetch").
//      The Tauri plugin runs the request on the Rust side (reqwest), bypassing
//      the webview's same-origin policy entirely.
//   2. Custom headers — a real User-Agent is needed or DuckDuckGo serves a
//      degraded/JS page; the webview forbids setting User-Agent.
// Allowed URLs are scoped in src-tauri/capabilities/default.json (http:default).
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

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

/** Default fetch options — realistic browser User-Agent so search engines serve real HTML. */
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
    const resp = await tauriFetch(`https://r.jina.ai/${url}`, {
      method: "GET",
      headers: browserHeaders({ Accept: "text/markdown" }),
    });
    if (resp.ok) {
      const text = await resp.text();
      return text.slice(0, 30000); // Limit to 30K chars
    }
  } catch { /* fall through to direct fetch */ }

  // Fallback: direct fetch
  const resp = await tauriFetch(url, { method: "GET", headers: browserHeaders() });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const html = await resp.text();
  return extractText(html).slice(0, 30000);
}

// ── Tavily ──────────────────────────────────────────────────────────────

async function searchTavily(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  if (!config.tavilyApiKey) throw new Error("Tavily API key not configured");
  const resp = await tauriFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: browserHeaders({ "Content-Type": "application/json" }),
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
  const resp = await tauriFetch(`${base}/search?format=json&q=${encodeURIComponent(query)}`, {
    method: "GET",
    headers: browserHeaders(),
  });
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

/** Common browser headers sent on every request. With `unsafe-headers` enabled
 *  on the Rust plugin we can set Origin/Referer, which makes DuckDuckGo treat
 *  the request as a normal browser visit instead of an anomaly/anomaly page
 *  (which is what "搜索失败" actually was — DDG returned a non-results page). */
function browserHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "User-Agent": DEFAULT_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "Referer": "https://lite.duckduckgo.com/",
    "Origin": "https://lite.duckduckgo.com",
    ...extra,
  };
}

async function searchDuckDuckGo(query: string, config: WebSearchConfig): Promise<WebSearchResult[]> {
  const endpoints: { url: string; useJina?: boolean }[] = [
    // Direct: html.duckduckgo.com (more reliable, less heavy-handed bot detection)
    { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
    // Direct: lite.duckduckgo.com (classic non-JS endpoint)
    { url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}` },
    // Jina proxy: lets jina.ai (global IP) fetch DDG, returns markdown — works
    // even when DDG blocks our Tauri app's IP / TLS fingerprint entirely.
    { url: `https://r.jina.ai/https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, useJina: true },
  ];
  let lastErr: Error | null = null;

  for (const { url, useJina } of endpoints) {
    console.log("[webSearch] DuckDuckGo request (%s): %s", useJina ? "jina" : "direct", url);

    // Jina proxy: standard fetch() headers (Accept text/markdown); no Tauri UA needed
    if (useJina) {
      try {
        const resp = await tauriFetch(url, {
          method: "GET",
          headers: { Accept: "text/markdown", "User-Agent": DEFAULT_UA },
        });
        if (!resp.ok) {
          console.error("[webSearch] Jina HTTP", resp.status, resp.statusText);
          lastErr = new Error(`Jina DDG proxy failed: ${resp.status}`);
          continue;
        }
        const md = await resp.text();
        console.log("[webSearch] Jina markdown len:", md.length);
        const results = parseJinaSearchMarkdown(md, config.maxResults || 5);
        console.log("[webSearch] Jina parsed results:", results.length);
        if (results.length) return results;
        lastErr = new Error("Jina proxy returned no parseable results.");
        continue;
      } catch (e) {
        console.error("[webSearch] Jina fetch threw:", e);
        lastErr = new Error(`Jina proxy error: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }

    // Direct endpoint — try with browser headers
    let resp;
    try {
      const headers = /html\.duckduckgo\.com/.test(url)
        ? browserHeaders({ Referer: "https://duckduckgo.com/", Origin: "https://duckduckgo.com" })
        : browserHeaders();
      resp = await tauriFetch(url, { method: "GET", headers });
    } catch (e) {
      console.error("[webSearch] DuckDuckGo fetch threw:", e);
      lastErr = new Error(`DuckDuckGo request failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!resp.ok) {
      console.error("[webSearch] DuckDuckGo HTTP", resp.status, resp.statusText);
      lastErr = new Error(`DuckDuckGo search failed: ${resp.status}`);
      continue;
    }
    const html = await resp.text();
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || "(none)";
    console.log("[webSearch] DuckDuckGo HTML len:", html.length, "title:", title);

    if (/an anomaly|has detected|robot|rate limit|unusual traffic|captcha|are you human/i.test(html)) {
      lastErr = new Error("DuckDuckGo returned an anomaly/rate-limit page.");
      continue;
    }
    // Homepage redirect
    const hasResultTable = /class="result-(?:links|snippet|a)"/i.test(html) || /class="links"/i.test(html) || /result__a\b/i.test(html);
    if (!hasResultTable && !/at DuckDuckGo/i.test(html)) {
      console.warn("[webSearch] DuckDuckGo looks like homepage. Trying next endpoint.");
      lastErr = new Error("DuckDuckGo redirected to the homepage.");
      continue;
    }

    const results = parseDdgLiteHtml(html, config.maxResults || 5);
    console.log("[webSearch] DuckDuckGo parsed results:", results.length);
    if (results.length) return results;
    console.warn("[webSearch] DuckDuckGo result-page parsed 0 results. HTML len:", html.length);
    lastErr = new Error("DuckDuckGo result page parsed 0 results.");
  }

  throw lastErr || new Error("DuckDuckGo returned no results.");
}

/** Parse Jina's markdown rendering of a DuckDuckGo results page.
 *  Jina converts DDG → markdown like:
 *    # <title>
 *    1. [Result Title](https://r.duckduckgo.com/l/?uddg=REAL_URL)... snippet text
 *    2. [Result Title](https://duckduckgo.com/l/?uddg=REAL_URL)... snippet text
 *  We extract the real URL from the redirect, the title from the link text,
 *  and the snippet from the trailing text. */
function parseJinaSearchMarkdown(md: string, max: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  // Jina renders search results as numbered items with a markdown link
  // followed by snippet text on the same or next line
  const itemRe = /(?:^|\n)\d+\.\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(md)) !== null) {
    const rawTitle = m[1];
    const rawUrl = m[2];
    // Unwrap DDG redirect if present
    const url = unwrapDdgRedirect(rawUrl);
    if (isDdgInternal(url)) continue;
    // Snippet: everything after the link on this line, minus leading " - " or "  "
    const lineStart = m.index + m[0].length;
    const lineEnd = md.indexOf("\n", lineStart);
    const rest = lineEnd > lineStart ? md.slice(lineStart, lineEnd) : md.slice(lineStart);
    const snippet = rest.replace(/^\s*[-–]\s*/, "").replace(/^\s*\.{3,}\s*/, "").trim();
    // If no snippet on this line, peek at next line (max 200 chars)
    let content = snippet;
    if (!content && lineEnd > 0) {
      const nextLine = md.slice(lineEnd + 1, lineEnd + 201).trim();
      content = nextLine.replace(/^\d+\.\s+.*$/, "").trim().slice(0, 300);
    }
    out.push({
      title: stripTags(decodeHtmlEntities(rawTitle)), // stripTags handles markdown remnants
      url,
      content: content.slice(0, 600),
    });
    if (out.length >= max || out.length >= 10) break;
  }
  return out;
}

/** Parse DuckDuckGo Lite HTML via the live DOM. Robust to layout variation:
 *  collects result link anchors and pairs each with a nearby snippet. */
function parseDdgLiteHtml(html: string, max: number): WebSearchResult[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: WebSearchResult[] = [];

  // Strategy 1 (modern Lite): anchor has class="result-link" or "result__a"
  // (html.duckduckgo.com uses double-underscore: a.result__a, .result__snippet).
  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>(
    'a.result-link, a.links, a.result__a, a[class*="result-link"], a[class*="result__a"]',
  ));
  for (const a of anchors) {
    const rawHref = a.getAttribute("href") || "";
    const href = unwrapDdgRedirect(rawHref);
    if (!href || isDdgInternal(href)) continue;
    const title = (a.textContent || "").trim();
    // Find the snippet: nearest sibling/ancestor td.result-snippet / .result__snippet
    const snippet = findSnippetForAnchor(a);
    out.push({
      title: decodeHtmlEntities(stripTags(title)) || href,
      url: href,
      content: decodeHtmlEntities(stripTags(snippet || "")),
    });
    if (out.length >= max) break;
  }
  if (out.length) return out;

  // Strategy 2: any anchor with rel="nofollow" (and also any with class
  // containing "result" — covers ddg variants) + an https result href, then
  // look for a snippet span/td nearby.
  const all = Array.from(doc.querySelectorAll<HTMLAnchorElement>(
    'a[rel="nofollow"], a.result, a[class*="result"]',
  ));
  for (const a of all) {
    const href = unwrapDdgRedirect(a.getAttribute("href") || "");
    if (!href || isDdgInternal(href)) continue;
    const title = (a.textContent || "").trim();
    const snippet = findSnippetForAnchor(a);
    out.push({
      title: decodeHtmlEntities(stripTags(title)) || href,
      url: href,
      content: decodeHtmlEntities(stripTags(snippet || "")),
    });
    if (out.length >= max) break;
  }
  return out;
}

/** DDG Lite wraps external result URLs in a redirect: //r.duckduckgo.com/l/?uddg=<encodedURL>...
 *  Unwrap to the real target. */
function unwrapDdgRedirect(href: string): string {
  if (!href) return href;
  if (/duckduckgo\.com\/l\/\?uddg=/.test(href) || /[?&]uddg=/.test(href)) {
    try {
      const u = new URL(href.startsWith("//") ? "https:" + href : href);
      const target = u.searchParams.get("uddg");
      if (target) return target;
    } catch { /* fall through */ }
  }
  if (/^\/\//.test(href)) return "https:" + href;
  if (/^\//.test(href)) return "https://duckduckgo.com" + href;
  return href;
}

function isDdgInternal(url: string): boolean {
  return /^https?:\/\/([^/]*\.)?duckduckgo\.com\//.test(url) && !/duckduckgo\.com\/l\/\?uddg=/.test(url);
}

/** Find the snippet associated with a result anchor: search ancestors and
 *  following siblings/cells for result-snippet / snippet / link-text elements. */
function findSnippetForAnchor(a: HTMLAnchorElement): string {
  const SNIPPET_SEL = ".result-snippet, .result__snippet, .snippet, [class*='snippet']";
  let el: HTMLElement | null = a;
  // Walk up until we find a snippet sibling within an ancestor
  for (let depth = 0; depth < 4 && el; depth++) {
    // Look in the same row / cell container
    const container = el.parentElement;
    if (container) {
      const snip = container.querySelector(SNIPPET_SEL);
      if (snip && snip.textContent) return snip.textContent;
    }
    el = el.parentElement;
  }
  // Look forward among following siblings up to a small distance
  let cur: Element | null = a;
  for (let i = 0; i < 8 && cur; i++) {
    cur = cur.nextElementSibling;
    if (!cur) break;
    const snip = cur.matches(SNIPPET_SEL)
      ? cur
      : cur.querySelector(SNIPPET_SEL);
    if (snip && snip.textContent) return snip.textContent;
  }
  return "";
}

/** Strip tags inside a captured title/snippet (e.g. <b>...</b>, <span>...</span>). */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
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
