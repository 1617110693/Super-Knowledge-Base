// Shared types for the desktop app

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  document_count: number;
  chunk_count: number;
  embedding_model: string;
  embedding_dim: number;
  pinned: boolean;
}

export interface Document {
  id: string;
  kb_id: string;
  name: string;
  file_type: string;
  file_size: number;
  parse_status: "pending" | "parsing" | "done" | "failed";
  parse_error?: string;
  chunk_count: number;
  embedding_model: string;
  path?: string | null;
  parent_doc_id?: string;   // set on split parts, links back to parent doc
  parts?: Document[];        // frontend-only: populated after grouping child documents
  created_at: string;
  updated_at: string;
}

export interface DocumentContent {
  id: string;
  name: string;
  markdown: string;
  md_available: boolean;
  metadata: Record<string, unknown>;
}

export interface ParseProgress {
  percent: number;
  stage: string;
}

export interface ParseTask {
  task_id: string;
  state: "pending" | "running" | "done" | "failed" | "converting";
  progress?: ParseProgress;
  full_zip_url?: string;
  err_msg?: string;
}

export interface ChatRequest {
  kb_id: string;
  query: string;
  top_k?: number;
  rerank?: boolean;
  stream?: boolean;
}

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface ChatSettings {
  selectedKbIds: string[];
  contextWindow: number;
  webSearchMode?: "off" | "smart" | "on";
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  sources?: SearchResult[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface NeighborChunk {
  chunk_id: string;
  content: string;
  chunk_index: number;
  page_number?: number;
  page_start?: number;
  page_end?: number;
  content_type?: string;
  metadata?: Record<string, unknown>;
}

export interface ChunkContext {
  prev: NeighborChunk[];
  next: NeighborChunk[];
}

export interface SearchResult {
  chunk_id: string;
  doc_id: string;
  kb_id: string;
  doc_name: string;
  content: string;
  score: number;
  content_type?: string;
  page_start?: number;
  page_end?: number;
  metadata: {
    page?: number;
    page_start?: number;
    page_end?: number;
    chunk_index?: number;
    content_type?: string;
    [key: string]: unknown;
  };
  context?: ChunkContext;
}

export interface SearchRequest {
  kb_id: string;
  query: string;
  search_type: "hybrid" | "vector" | "fts";
  top_k: number;
  rerank: boolean;
  context_window?: number;
  filters?: {
    doc_id?: string;
  };
}

export interface SearchAllRequest {
  kb_ids?: string[];
  query: string;
  search_type: "hybrid" | "vector" | "fts";
  top_k: number;
  rerank: boolean;
  context_window?: number;
}

export interface AppSettings {
  data_dir: string;
  mineru_token: string;
  embedding_api_base: string;
  embedding_api_key: string;
  embedding_model: string;
  rerank_api_base: string;
  rerank_api_key: string;
  rerank_model: string;
  use_local_embedding: boolean;
  local_embedding_model: string;
  use_local_rerank: boolean;
  local_rerank_model: string;
  llama_port: number;
  llama_threads: number;
  llm_api_base: string;
  llm_api_key: string;
  llm_model: string;
  vlm_api_base: string;
  vlm_api_key: string;
  vlm_model: string;
  vlm_enabled: boolean;
  vlm_concurrency: number;
  extract_multimodal: boolean;
  chunk_strategy: "fixed" | "semantic" | "recursive";
  chunk_size: number;
  chunk_overlap: number;
  python_port: number;
  theme: "light" | "dark" | "system";
  max_tool_rounds: number;
  max_history_messages: number;
  max_search_result_chars: number;
  max_document_chars: number;
  max_chunk_chars: number;
  // Web search
  web_search_provider: "bing" | "duckduckgo" | "tavily" | "searxng";
  tavily_api_key: string;
  searxng_base_url: string;
  web_search_proxy: string;
  web_search_max_results: number;
  fontSize: number;
  markdownTheme?: string;
  has_seen_guide?: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  data_dir: "",
  mineru_token: "",
  embedding_api_base: "https://api.openai.com/v1",
  embedding_api_key: "",
  embedding_model: "text-embedding-3-small",
  rerank_api_base: "https://api.jina.ai/v1",
  rerank_api_key: "",
  rerank_model: "jina-reranker-v2-base-multilingual",
  use_local_embedding: false,
  local_embedding_model: "",
  use_local_rerank: false,
  local_rerank_model: "",
  llama_port: 8081,
  llama_threads: 4,
  llm_api_base: "https://api.openai.com/v1",
  llm_api_key: "",
  llm_model: "gpt-4o-mini",
  vlm_api_base: "",
  vlm_api_key: "",
  vlm_model: "",
  vlm_enabled: true,
  vlm_concurrency: 5,
  extract_multimodal: true,
  chunk_strategy: "recursive",
  chunk_size: 512,
  chunk_overlap: 50,
  python_port: 17390,
  theme: "system",
  max_tool_rounds: 100,
  max_history_messages: 80,
  max_search_result_chars: 2000,
  max_document_chars: 30000,
  max_chunk_chars: 800,
  web_search_provider: "bing",
  tavily_api_key: "",
  searxng_base_url: "",
  web_search_proxy: "",
  web_search_max_results: 5,
  fontSize: 15,
  markdownTheme: "academic",
  has_seen_guide: false,
};
