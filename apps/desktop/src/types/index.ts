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
  created_at: string;
  updated_at: string;
}

export interface DocumentContent {
  id: string;
  markdown: string;
  metadata: Record<string, unknown>;
}

export interface ParseTask {
  task_id: string;
  state: "pending" | "running" | "done" | "failed" | "converting";
  progress?: {
    extracted_pages: number;
    total_pages: number;
    start_time: string;
  };
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

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SearchResult {
  chunk_id: string;
  doc_id: string;
  doc_name: string;
  content: string;
  score: number;
  metadata: {
    page?: number;
    chunk_index?: number;
    [key: string]: unknown;
  };
}

export interface SearchRequest {
  kb_id: string;
  query: string;
  search_type: "hybrid" | "vector" | "fts";
  top_k: number;
  rerank: boolean;
  filters?: {
    doc_id?: string;
  };
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
  chunk_strategy: "fixed" | "semantic" | "recursive";
  chunk_size: number;
  chunk_overlap: number;
  python_port: number;
  theme: "light" | "dark" | "system";
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
  chunk_strategy: "recursive",
  chunk_size: 512,
  chunk_overlap: 50,
  python_port: 17390,
  theme: "system",
};
