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
          content_type: {
            type: "string",
            enum: ["text", "image", "table", "equation"],
            description: "Filter by content type. Omit for all. 'image'=figures/charts, 'table'=data tables, 'equation'=formulas.",
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
  // ── Memory tools ──────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "create_entities",
      description: "Create new memory entities about the user. Each entity has a unique name, a type (person/preference/project/topic/fact), and observations (facts about it). Use this to remember important information the user shares.",
      parameters: {
        type: "object",
        properties: {
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Unique entity name" },
                entityType: { type: "string", description: "Type: person, preference, project, topic, or fact" },
                observations: { type: "array", items: { type: "string" }, description: "Facts/observations about this entity" },
              },
              required: ["name", "entityType", "observations"],
            },
          },
        },
        required: ["entities"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_relations",
      description: "Create relations between existing memory entities (e.g., User A --likes--> Topic B). Both entities must already exist.",
      parameters: {
        type: "object",
        properties: {
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: "Source entity name" },
                to: { type: "string", description: "Target entity name" },
                relationType: { type: "string", description: "Relation type: likes, prefers, works_on, related_to" },
              },
              required: ["from", "to", "relationType"],
            },
          },
        },
        required: ["relations"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_observations",
      description: "Add new observations/facts to existing memory entities. Use this to update what you know about the user as you learn new information.",
      parameters: {
        type: "object",
        properties: {
          observations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                entityName: { type: "string", description: "Name of the entity to add facts to" },
                contents: { type: "array", items: { type: "string" }, description: "New facts to add" },
              },
              required: ["entityName", "contents"],
            },
          },
        },
        required: ["observations"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_entities",
      description: "Delete memory entities by name. Also removes their relations. Use sparingly — only when the user explicitly asks to forget something.",
      parameters: {
        type: "object",
        properties: {
          entityNames: {
            type: "array",
            items: { type: "string" },
            description: "Names of entities to delete",
          },
        },
        required: ["entityNames"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_nodes",
      description: "Search the memory graph for entities matching a query. Searches entity names, types, and observations. Use this to find relevant memories before responding.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_graph",
      description: "Read the entire memory graph to see all stored entities, observations, and relations. Use this to get an overview of what you already know about the user.",
      parameters: { type: "object", properties: {} },
    },
  },
  // ── Web search tools ──────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the internet for up-to-date information. Use this when the user's question cannot be answered from local knowledge bases, or when asking about recent events, news, or information beyond your training data. Returns titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — use keywords relevant to what you need to find",
          },
          max_results: {
            type: "integer",
            description: "Maximum number of results to return (default 5, max 10)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch and read the full content of a web page URL. Use this after web_search to read a specific result's full content in detail.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full URL of the web page to fetch and read",
          },
        },
        required: ["url"],
      },
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
    case "web_search": {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        return `Searching web: "${args.query || ""}"`;
      } catch {
        return "Searching the web...";
      }
    }
    case "web_fetch": {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        return `Fetching: ${args.url || ""}`;
      } catch {
        return "Fetching web page...";
      }
    }
    case "create_entities":
      return "Saving memories...";
    case "create_relations":
      return "Creating memory relations...";
    case "add_observations":
      return "Adding memory observations...";
    case "delete_entities":
      return "Deleting memories...";
    case "search_nodes":
      return "Searching memory...";
    case "read_graph":
      return "Reading memory graph...";
    default:
      return `Running ${toolCall.function.name}...`;
  }
}
