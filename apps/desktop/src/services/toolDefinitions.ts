// OpenAI function-calling tool definitions for the Chat LLM.
// The LLM can call these to search KBs, read documents, etc.
import type { ToolCall } from "../types";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const CHAT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description:
        "Search across knowledge bases for relevant document chunks. Use this to find information related to the user's question before answering.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query — use keywords from the user's question",
          },
          kb_ids: {
            type: "array",
            items: { type: "string" },
            description: "Knowledge base IDs to search. Omit to search all available KBs.",
          },
          top_k: {
            type: "integer",
            description: "Number of results to return (default 10, max 50)",
          },
          search_type: {
            type: "string",
            enum: ["hybrid", "vector", "fts"],
            description: "Search type: hybrid (default), vector, or fts (keyword)",
          },
          rerank: {
            type: "boolean",
            description: "Whether to rerank results for better relevance (default true)",
          },
          context_window: {
            type: "integer",
            description: "Number of neighboring chunks to include before/after each result (default 0, max 3). Set to 1-2 for more context around each hit.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_document",
      description:
        "Fetch the full markdown content of a specific document from a knowledge base. Use this when you need to read a complete document referenced in search results.",
      parameters: {
        type: "object",
        properties: {
          kb_id: { type: "string", description: "Knowledge base ID" },
          doc_id: { type: "string", description: "Document ID" },
        },
        required: ["kb_id", "doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_document_chunks",
      description:
        "Get all chunks of a specific document, sorted by chunk_index. Use this to see the full chunked structure of a document.",
      parameters: {
        type: "object",
        properties: {
          kb_id: { type: "string", description: "Knowledge base ID" },
          doc_id: { type: "string", description: "Document ID" },
        },
        required: ["kb_id", "doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_documents",
      description:
        "List all documents in a specific knowledge base. Use this to see what documents are available before searching or reading.",
      parameters: {
        type: "object",
        properties: {
          kb_id: { type: "string", description: "Knowledge base ID" },
        },
        required: ["kb_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_chunk_by_index",
      description:
        "Fetch a specific chunk from a document by its chunk_index. Use this when you need more context beyond what search_knowledge_base returned — for example, if the neighboring chunks weren't enough, request chunk_index-2 or chunk_index+2 to read further. The response includes prev_exists/next_exists hints.",
      parameters: {
        type: "object",
        properties: {
          kb_id: { type: "string", description: "Knowledge base ID" },
          doc_id: { type: "string", description: "Document ID" },
          chunk_index: { type: "integer", description: "The chunk index to fetch (0-based)" },
        },
        required: ["kb_id", "doc_id", "chunk_index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_chunks_by_page",
      description:
        "Fetch all chunks on a specific page of a document. Use this when the user asks what's on a particular page number, or when you need to read all content from a page referenced in search results.",
      parameters: {
        type: "object",
        properties: {
          kb_id: { type: "string", description: "Knowledge base ID" },
          doc_id: { type: "string", description: "Document ID" },
          page: { type: "integer", description: "Page number to fetch (from page_start/page_end in search results)" },
        },
        required: ["kb_id", "doc_id", "page"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_knowledge_bases",
      description:
        "List all available knowledge bases with their document and chunk counts. Use this to discover what knowledge bases exist before searching.",
      parameters: { type: "object", properties: {} },
    },
  },
];

/** Return a human-readable label for a tool call (for interstitial UI). */
export function toolLabel(toolCall: ToolCall): string {
  switch (toolCall.function.name) {
    case "search_knowledge_base": {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        return `Searching: "${args.query || ""}"`;
      } catch {
        return "Searching...";
      }
    }
    case "get_document":
      return "Reading document...";
    case "get_document_chunks":
      return "Loading document chunks...";
    case "list_knowledge_bases":
      return "Listing knowledge bases...";
    case "list_documents":
      return "Listing documents...";
    case "get_chunk_by_index":
      return "Fetching specific chunk...";
    default:
      return `Running ${toolCall.function.name}...`;
  }
}
