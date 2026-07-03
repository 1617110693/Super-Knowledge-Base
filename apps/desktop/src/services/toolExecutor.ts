// Executes tool calls from the LLM by dispatching to the appropriate
// backend API (Python REST or Tauri IPC).
import type { SearchResult, ToolCall } from "../types";
import { searchAll } from "./pythonClient";
import { getDocumentContent } from "./tauriBridge";

export interface ToolExecutionResult {
  tool_call_id: string;
  role: "tool";
  content: string;
}

interface KbInfo {
  id: string;
  name: string;
  document_count: number;
  chunk_count: number;
}

export interface ToolLimits {
  maxSearchResultChars: number;
  maxDocumentChars: number;
  maxChunkChars: number;
}

export async function executeToolCall(
  toolCall: ToolCall,
  kbList: KbInfo[],
  limits?: ToolLimits,
  allowedKbIds?: string[],
  defaultContextWindow?: number,
  sourceOffset: number = 0,
): Promise<{ result: ToolExecutionResult; newSources: SearchResult[] }> {
  const { name, arguments: argsJson } = toolCall.function;
  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(argsJson);
  } catch {
    parsedArgs = {};
  }

  // Helper to enforce KB access restrictions
  const checkKbAccess = (kbId: string): string | null => {
    if (allowedKbIds && allowedKbIds.length > 0 && !allowedKbIds.includes(kbId)) {
      return `Access denied: knowledge base "${kbId}" is not selected. Only these KBs are available: ${allowedKbIds.join(", ")}`;
    }
    return null;
  };

  switch (name) {
    // ── search_knowledge_base ──
    case "search_knowledge_base": {
      const query = String(parsedArgs.query || "");
      let kbIds: string[] | undefined = Array.isArray(parsedArgs.kb_ids) && parsedArgs.kb_ids.length > 0
        ? (parsedArgs.kb_ids as string[])
        : undefined;
      // If user has selected KBs, restrict search to only those
      if (allowedKbIds && allowedKbIds.length > 0) {
        kbIds = kbIds ? kbIds.filter((id) => allowedKbIds.includes(id)) : allowedKbIds;
        if (kbIds.length === 0) {
          return { result: { tool_call_id: toolCall.id, role: "tool", content: JSON.stringify({ error: "None of the requested KBs are selected. Please select KBs in the chat header." }) }, newSources: [] };
        }
      }
      const topK = Math.min(Number(parsedArgs.top_k) || 10, 50);
      const searchType = (parsedArgs.search_type as string) || "hybrid";
      const rerank = parsedArgs.rerank !== false;
      const contextWindow = Math.min(Number(parsedArgs.context_window) || defaultContextWindow || 0, 3);

      const res = await searchAll({
        kb_ids: kbIds,
        query,
        search_type: searchType as "hybrid" | "vector" | "fts",
        top_k: topK,
        rerank,
        context_window: contextWindow,
      });

      const maxChars = limits?.maxSearchResultChars ?? 2000;

      return {
        result: {
          tool_call_id: toolCall.id,
          role: "tool",
          content: JSON.stringify({
            total: res.results.length,
            results: res.results.map((r, i) => {
              const entry: Record<string, unknown> = {
                index: sourceOffset + i + 1,
                doc_id: r.doc_id,
                doc_name: r.doc_name,
                chunk_index: r.metadata?.chunk_index,
                score: Math.round(r.score * 100) / 100,
                content: r.content.slice(0, maxChars),
                page: r.metadata?.page,
              };
              // Include neighbor context if present
              if (r.context) {
                if (r.context.prev.length > 0) {
                  entry.prev_chunks = r.context.prev.map((c) => ({
                    content: c.content.slice(0, maxChars),
                    chunk_index: c.chunk_index,
                  }));
                }
                if (r.context.next.length > 0) {
                  entry.next_chunks = r.context.next.map((c) => ({
                    content: c.content.slice(0, maxChars),
                    chunk_index: c.chunk_index,
                  }));
                }
              }
              return entry;
            }),
          }),
        },
        newSources: res.results,
      };
    }

    // ── get_document ──
    case "get_document": {
      const kbId = String(parsedArgs.kb_id);
      const docId = String(parsedArgs.doc_id);
      const accessErr = checkKbAccess(kbId);
      if (accessErr) return { result: { tool_call_id: toolCall.id, role: "tool", content: JSON.stringify({ error: accessErr }) }, newSources: [] };
      const doc = await getDocumentContent(kbId, docId);

      return {
        result: {
          tool_call_id: toolCall.id,
          role: "tool",
          content: JSON.stringify({
            doc_id: doc.id,
            name: doc.name,
            markdown: doc.markdown.slice(0, limits?.maxDocumentChars ?? 30000),
          }),
        },
        newSources: [],
      };
    }

    // ── get_document_chunks ──
    case "get_document_chunks": {
      const kbId = String(parsedArgs.kb_id);
      const accessErr2 = checkKbAccess(kbId);
      if (accessErr2) return { result: { tool_call_id: toolCall.id, role: "tool", content: JSON.stringify({ error: accessErr2 }) }, newSources: [] };
      const docId = String(parsedArgs.doc_id);
      // Use FTS search with a broad query to find all chunks for this doc
      const res = await searchAll({
        kb_ids: [kbId],
        query: " ",
        search_type: "fts",
        top_k: 500,
        rerank: false,
      });
      const docChunks = res.results.filter((r) => r.doc_id === docId);

      return {
        result: {
          tool_call_id: toolCall.id,
          role: "tool",
          content: JSON.stringify({
            doc_id: docId,
            chunk_count: docChunks.length,
            chunks: docChunks.map((c, i) => ({
              index: i,
              content: c.content.slice(0, limits?.maxChunkChars ?? 800),
              page: c.metadata?.page,
            })),
          }),
        },
        newSources: [],
      };
    }

    // ── list_documents ──
    case "list_documents": {
      const kbId = String(parsedArgs.kb_id);
      const accessErr3 = checkKbAccess(kbId);
      if (accessErr3) return { result: { tool_call_id: toolCall.id, role: "tool", content: JSON.stringify({ error: accessErr3 }) }, newSources: [] };
      const { listDocuments } = await import("./tauriBridge");
      const docs = await listDocuments(kbId);

      return {
        result: {
          tool_call_id: toolCall.id,
          role: "tool",
          content: JSON.stringify({
            kb_id: kbId,
            total_documents: docs.length,
            documents: docs.map((d) => ({
              doc_id: d.id,
              name: d.name,
              file_type: d.file_type,
              file_size: d.file_size,
              chunk_count: d.chunk_count,
              parse_status: d.parse_status,
              path: d.path,
              created_at: d.created_at,
              updated_at: d.updated_at,
            })),
          }),
        },
        newSources: [],
      };
    }

    // ── get_chunk_by_index ──
    case "get_chunk_by_index": {
      const kbId = String(parsedArgs.kb_id);
      const accessErr4 = checkKbAccess(kbId);
      if (accessErr4) return { result: { tool_call_id: toolCall.id, role: "tool", content: JSON.stringify({ error: accessErr4 }) }, newSources: [] };
      const docId = String(parsedArgs.doc_id);
      const chunkIdx = Number(parsedArgs.chunk_index);
      if (isNaN(chunkIdx)) return { result: { tool_call_id: toolCall.id, role: "tool", content: JSON.stringify({ error: "chunk_index must be a number" }) }, newSources: [] };

      const { getChunkByIndex } = await import("./pythonClient");
      const res = await getChunkByIndex({ kb_id: kbId, doc_id: docId, chunk_index: chunkIdx });
      if ("error" in res) {
        return { result: { tool_call_id: toolCall.id, role: "tool", content: JSON.stringify({ error: res.error }) }, newSources: [] };
      }

      const c = res.chunk;
      return {
        result: {
          tool_call_id: toolCall.id,
          role: "tool",
          content: JSON.stringify({
            doc_id: c.doc_id,
            doc_name: c.doc_name,
            chunk_index: c.chunk_index,
            page_number: c.page_number,
            content: c.content.slice(0, limits?.maxChunkChars ?? 800),
            prev_exists: c.prev_exists,
            next_exists: c.next_exists,
            hint: "Use get_chunk_by_index with chunk_index ±1 to fetch more context in this direction.",
          }),
        },
        newSources: [],
      };
    }

    // ── get_chunks_by_page ──
    case "get_chunks_by_page": {
      const kbId5 = String(parsedArgs.kb_id);
      const docId3 = String(parsedArgs.doc_id);
      const page = Number(parsedArgs.page);
      if (isNaN(page)) return { result: { tool_call_id: toolCall.id, role: "tool", content: JSON.stringify({ error: "page must be a number" }) }, newSources: [] };
      const { getChunksByPage } = await import("./pythonClient");
      const res = await getChunksByPage({ kb_id: kbId5, doc_id: docId3, page });
      return {
        result: {
          tool_call_id: toolCall.id,
          role: "tool",
          content: JSON.stringify({
            kb_id: res.kb_id,
            doc_id: res.doc_id,
            page: res.page,
            count: res.count,
            chunks: res.chunks.map(c => ({
              chunk_index: c.chunk_index,
              page_start: c.page_start,
              page_end: c.page_end,
              content: c.content.slice(0, limits?.maxChunkChars ?? 800),
            })),
          }),
        },
        newSources: [],
      };
    }

    // ── list_knowledge_bases ──
    case "list_knowledge_bases": {
      const filtered = allowedKbIds && allowedKbIds.length > 0
        ? kbList.filter((kb) => allowedKbIds.includes(kb.id))
        : kbList;
      return {
        result: {
          tool_call_id: toolCall.id,
          role: "tool",
          content: JSON.stringify({
            knowledge_bases: filtered.map((kb) => ({
              id: kb.id,
              name: kb.name,
              document_count: kb.document_count,
              chunk_count: kb.chunk_count,
            })),
          }),
        },
        newSources: [],
      };
    }

    default: {
      return {
        result: {
          tool_call_id: toolCall.id,
          role: "tool",
          content: JSON.stringify({ error: `Unknown tool: ${name}` }),
        },
        newSources: [],
      };
    }
  }
}
