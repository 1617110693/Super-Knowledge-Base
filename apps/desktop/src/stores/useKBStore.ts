import { create } from "zustand";
import type { KnowledgeBase, Document } from "../types";
import * as tauriBridge from "../services/tauriBridge";

interface KBState {
  knowledgeBases: KnowledgeBase[];
  activeKB: KnowledgeBase | null;
  documents: Document[];
  loading: boolean;
  error: string | null;
  indexingIds: Set<string>;

  loadKBs: () => Promise<void>;
  loadDocuments: (kbId: string) => Promise<void>;
  createKB: (name: string, description: string) => Promise<void>;
  updateKB: (kbId: string, name: string | null, description: string | null) => Promise<void>;
  copyKB: (kbId: string) => Promise<void>;
  deleteKB: (kbId: string) => Promise<void>;
  setActiveKB: (kb: KnowledgeBase | null) => void;
  uploadDocument: (kbId: string, filePath: string) => Promise<void>;
  deleteDocument: (kbId: string, docId: string) => Promise<void>;
  refreshDocument: (kbId: string, docId: string) => Promise<void>;
  reindexDocument: (kbId: string, docId: string, docName: string) => Promise<void>;
  reindexAll: (kbId: string) => Promise<void>;
}

export const useKBStore = create<KBState>((set, get) => ({
  knowledgeBases: [],
  activeKB: null,
  documents: [],
  loading: false,
  error: null,
  indexingIds: new Set(),

  loadKBs: async () => {
    set({ loading: true, error: null });
    try {
      const kbs = await tauriBridge.listKBs();
      set({ knowledgeBases: kbs, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  loadDocuments: async (kbId: string) => {
    // Clear old documents immediately so we never show stale data
    // from a previously selected KB on error.
    set({ loading: true, error: null, documents: [] });
    try {
      const docs = await tauriBridge.listDocuments(kbId);
      set({ documents: docs, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createKB: async (name: string, description: string) => {
    const kb = await tauriBridge.createKB(name, description);
    set((s) => ({ knowledgeBases: [...s.knowledgeBases, kb] }));
  },

  updateKB: async (kbId: string, name: string | null, description: string | null) => {
    const updated = await tauriBridge.updateKB(kbId, name, description);
    set((s) => ({
      knowledgeBases: s.knowledgeBases.map((k) => (k.id === kbId ? { ...k, ...updated } : k)),
      activeKB: s.activeKB?.id === kbId ? { ...s.activeKB, ...updated } : s.activeKB,
    }));
  },

  copyKB: async (kbId: string) => {
    const kb = await tauriBridge.copyKB(kbId);
    set((s) => ({
      knowledgeBases: [...s.knowledgeBases, kb],
    }));
    // Also copy LanceDB table data via Python backend
    try {
      const { copyKbLanceDb } = await import("../services/pythonClient");
      await copyKbLanceDb(kbId, kb.id);
    } catch (e) {
      console.error("LanceDB copy failed (docs still copied):", e);
    }
  },

  deleteKB: async (kbId: string) => {
    await tauriBridge.deleteKB(kbId);
    set((s) => ({
      knowledgeBases: s.knowledgeBases.filter((k) => k.id !== kbId),
      activeKB: s.activeKB?.id === kbId ? null : s.activeKB,
    }));
  },

  setActiveKB: (kb) => set({ activeKB: kb }),

  uploadDocument: async (kbId: string, filePath: string) => {
    // 1. Check embedding model consistency
    const kbs = get().knowledgeBases;
    const kb = kbs.find((k) => k.id === kbId);
    if (kb && kb.embedding_model) {
      const { getSettings } = await import("../services/tauriBridge");
      const settings = await getSettings();
      if (settings.embedding_model && settings.embedding_model !== kb.embedding_model) {
        throw new Error(
          `Embedding model mismatch: this knowledge base uses "${kb.embedding_model}" (dim ${kb.embedding_dim}), but current settings use "${settings.embedding_model}". Please switch the embedding model in settings or use "Re-index All" to rebind.`
        );
      }
    }

    // 2. Upload (may split large PDFs into parts)
    const uploadResult = await tauriBridge.uploadDocument(kbId, filePath);
    const doc = uploadResult.document;
    const allDocs = [doc, ...uploadResult.parts];
    set((s) => ({ documents: [...allDocs, ...s.documents] }));

    // 3. Parse each document
    for (const d of allDocs) {
      try {
        await tauriBridge.startParsing(kbId, d.id);
        const parsed = await tauriBridge.pollParseStatus(kbId, d.id);
        set((s) => ({
          documents: s.documents.map((dd) => (dd.id === d.id ? parsed : dd)),
        }));

        // 4. Index (if parsing succeeded)
        if (parsed.parse_status === "done") {
          set((s) => ({ indexingIds: new Set([...s.indexingIds, d.id]) }));
          try {
            const { getDocumentContent, saveDocumentChunks } = await import(
              "../services/tauriBridge"
            );
            const { indexDocument } = await import("../services/pythonClient");
            const content = await getDocumentContent(kbId, d.id);
            const result = await indexDocument({
              kb_id: kbId,
              doc_id: d.id,
              doc_name: d.name,
              markdown_content: content.markdown,
            });
            await saveDocumentChunks(kbId, d.id, result.chunk_count, result.embedding_model, result.embedding_dim);
            set((s) => ({
              documents: s.documents.map((dd) =>
                dd.id === d.id ? { ...dd, chunk_count: result.chunk_count, embedding_model: result.embedding_model } : dd
              ),
              knowledgeBases: s.knowledgeBases.map((k) =>
                k.id === kbId ? { ...k, embedding_model: result.embedding_model, embedding_dim: result.embedding_dim } : k
              ),
              indexingIds: new Set([...s.indexingIds].filter((id) => id !== d.id)),
            }));
          } catch (e) {
            console.error("Auto-index failed:", e);
            set((s) => ({
              indexingIds: new Set([...s.indexingIds].filter((id) => id !== d.id)),
            }));
          }
        }
      } catch { /* parse failed, keep original doc */ }
    }
  },

  deleteDocument: async (kbId: string, docId: string) => {
    await tauriBridge.deleteDocument(kbId, docId);
    set((s) => ({
      documents: s.documents.filter((d) => d.id !== docId),
    }));
  },

  refreshDocument: async (kbId: string, docId: string) => {
    const doc = await tauriBridge.pollParseStatus(kbId, docId);
    set((s) => ({
      documents: s.documents.map((d) => (d.id === docId ? doc : d)),
    }));
  },

  reindexDocument: async (kbId: string, docId: string, docName: string) => {
    set((s) => ({ indexingIds: new Set([...s.indexingIds, docId]) }));
    try {
      const { getDocumentContent, saveDocumentChunks } = await import("../services/tauriBridge");
      const { indexDocument } = await import("../services/pythonClient");
      const content = await getDocumentContent(kbId, docId);
      const result = await indexDocument({
        kb_id: kbId,
        doc_id: docId,
        doc_name: docName,
        markdown_content: content.markdown,
      });
      await saveDocumentChunks(kbId, docId, result.chunk_count, result.embedding_model, result.embedding_dim);
      set((s) => ({
        documents: s.documents.map((d) =>
          d.id === docId ? { ...d, chunk_count: result.chunk_count, embedding_model: result.embedding_model } : d
        ),
        knowledgeBases: s.knowledgeBases.map((k) =>
          k.id === kbId ? { ...k, embedding_model: result.embedding_model, embedding_dim: result.embedding_dim, chunk_count: k.chunk_count } : k
        ),
        indexingIds: new Set([...s.indexingIds].filter((id) => id !== docId)),
      }));
    } catch (e) {
      console.error("Re-index failed:", e);
      set((s) => ({
        indexingIds: new Set([...s.indexingIds].filter((id) => id !== docId)),
      }));
    }
  },

  reindexAll: async (kbId: string) => {
    // Create a backup of the LanceDB table before re-indexing
    try {
      const { backupKb } = await import("../services/pythonClient");
      await backupKb(kbId);
    } catch (e) {
      console.error("Backup before reindex failed:", e);
      // Continue anyway — backup is best-effort
    }
    const docs = get().documents;
    for (const doc of docs) {
      if (doc.parse_status === "done") {
        await get().reindexDocument(kbId, doc.id, doc.name);
      }
    }
  },
}));
