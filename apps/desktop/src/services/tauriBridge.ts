/**
 * Tauri IPC bridge — wraps invoke() calls to the Rust backend.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  KnowledgeBase,
  Document,
  DocumentContent,
  ParseTask,
  AppSettings,
} from "../types";

// ── Settings ──

export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export async function updateSettings(
  settings: AppSettings
): Promise<AppSettings> {
  return invoke("update_settings", { newSettings: settings });
}

// ── Knowledge Bases ──

export async function createKB(
  name: string,
  description: string
): Promise<KnowledgeBase> {
  return invoke("create_kb", { name, description });
}

export async function renameKB(kbId: string, name: string): Promise<KnowledgeBase> {
  return invoke("rename_kb", { kbId, name });
}

export async function deleteKB(kbId: string): Promise<void> {
  return invoke("delete_kb", { kbId });
}

export async function listKBs(): Promise<KnowledgeBase[]> {
  return invoke("list_kbs");
}

export async function getKB(kbId: string): Promise<KnowledgeBase> {
  return invoke("get_kb", { kbId });
}

// ── Documents ──

export async function uploadDocument(
  kbId: string,
  filePath: string
): Promise<Document> {
  return invoke("upload_document", { kbId, filePath });
}

export async function deleteDocument(
  kbId: string,
  docId: string
): Promise<void> {
  return invoke("delete_document", { kbId, docId });
}

export async function listDocuments(kbId: string): Promise<Document[]> {
  return invoke("list_documents", { kbId });
}

export async function getDocumentContent(
  kbId: string,
  docId: string
): Promise<DocumentContent> {
  return invoke("get_document_content", { kbId, docId });
}

export async function saveDocumentChunks(
  kbId: string,
  docId: string,
  chunkCount: number,
  embeddingModel: string,
  embeddingDim: number,
): Promise<Document> {
  return invoke("save_document_chunks", { kbId, docId, chunkCount, embeddingModel, embeddingDim });
}

// ── Parsing ──

export async function startParsing(
  kbId: string,
  docId: string
): Promise<ParseTask> {
  return invoke("start_parsing", { kbId, docId });
}

export async function pollParseStatus(
  kbId: string,
  docId: string
): Promise<Document> {
  return invoke("poll_parse_status", { kbId, docId });
}

// ── Python Backend ──

export async function getPythonBackendUrl(): Promise<string> {
  return invoke("get_python_backend_url");
}

export async function startPythonBackend(): Promise<{
  running: boolean;
  url: string;
  port: number;
  error: string | null;
}> {
  return invoke("start_python_backend");
}

export async function stopPythonBackend(): Promise<void> {
  return invoke("stop_python_backend");
}

export async function getPythonBackendStatus(): Promise<{
  running: boolean;
  url: string;
  port: number;
  error: string | null;
}> {
  return invoke("get_python_backend_status");
}

// ── Claude MCP Config ──

export async function configureClaudeMCP(): Promise<{
  success: boolean;
  path: string;
  message: string;
}> {
  return invoke("configure_claude_mcp");
}
