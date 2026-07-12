#!/usr/bin/env node
/**
 * Bing search helper — spawned as a child process by the Python backend.
 * Exists because Bing's edge-CDN identifies Python/rstls TLS fingerprints
 * as "non-browser" and redirects to the homepage, while Node.js native TLS
 * (Windows SChannel) passes the check.
 *
 * Usage: node bing_search.js "<query>" [max_results]
 * Output: JSON array of {title, url, content} on stdout.
 * Errors: JSON {error: "..."} on stderr, exits with code 1.
 */

const https = require("https");

const query = process.argv[2];
if (!query) {
  console.error(JSON.stringify({ error: "Missing query argument" }));
  process.exit(1);
}
const maxResults = parseInt(process.argv[3], 10) || 5;

const url =
  "https://cn.bing.com/search?q=" + encodeURIComponent(query);

https
  .get(
    url,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      timeout: 15000,
    },
    (res) => {
      let html = "";
      res.on("data", (c) => (html += c));
      res.on("end", () => {
        try {
          const results = parseBingHtml(html, maxResults);
          console.log(JSON.stringify(results));
        } catch (e) {
          console.error(JSON.stringify({ error: "Parse error: " + e.message }));
          process.exit(1);
        }
      });
    }
  )
  .on("error", (e) => {
    console.error(JSON.stringify({ error: "HTTP error: " + e.message }));
    process.exit(1);
  });

function parseBingHtml(html, max) {
  // Extract results from <li class="b_algo"> blocks
  const results = [];

  // Find all b_algo blocks
  const algoRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let algoMatch;
  while ((algoMatch = algoRe.exec(html)) !== null) {
    try {
      const block = algoMatch[1];

      // Extract title + URL from h2 a
      const linkRe = /<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const linkMatch = linkRe.exec(block);
      if (!linkMatch) continue;

      const url = linkMatch[1];
      const title = linkMatch[2].replace(/<[^>]+>/g, "").trim();
      if (!title) continue;

      // Extract snippet from .b_caption p
      const capRe = /<p[^>]*>([\s\S]*?)<\/p>/i;
      const capMatch = capRe.exec(block);
      const snippet = capMatch
        ? capMatch[1].replace(/<[^>]+>/g, "").trim()
        : "";

      results.push({ title, url, content: snippet });
      if (results.length >= max) break;
    } catch {
      // skip bad item
    }
  }
  return results;
}
