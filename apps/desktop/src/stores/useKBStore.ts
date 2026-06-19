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
  renameKB: (kbId: string, name: string) => Promise<void>;
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
    set({ loading: true, error: null });
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

  renameKB: async (kbId: string, name: string) => {
    const kb = await tauriBridge.renameKB(kbId, name);
    set((s) => ({
      knowledgeBases: s.knowledgeBases.map((k) => (k.id === kbId ? { ...k, ...kb } : k)),
      activeKB: s.activeKB?.id === kbId ? { ...s.activeKB, name } : s.activeKB,
    }));
  },

  deleteKB: async (kbId: string) => {
    await tauriBridge.deleteKB(kbId);
    set((s) => ({
      knowledgeBases: s.knowledgeBases.filter((k) => k.id !== kbId),
      activeKB: s.activeKB?.id === kbId ? null : s.activeKB,
    }));
  },

  setActiveKB: (kb) => set({ activeKB: kb, documents: [] }),

  uploadDocument: async (kbId: string, filePath: string) => {
    // 1. Upload
    const doc = await tauriBridge.uploadDocument(kbId, filePath);
    set((s) => ({ documents: [doc, ...s.documents] }));

    // 2. Parse (instant for .md/.txt, async via MinerU for others)
    let parsed = doc;
    try {
      await tauriBridge.startParsing(kbId, doc.id);
      parsed = await tauriBridge.pollParseStatus(kbId, doc.id);
    } catch { /* parse failed, keep original doc */ }
    set((s) => ({
      documents: s.documents.map((d) => (d.id === doc.id ? parsed : d)),
    }));

    // 3. Index (if parsing succeeded)
    if (parsed.parse_status === "done") {
      set((s) => ({ indexingIds: new Set([...s.indexingIds, doc.id]) }));
      try {
        const { getDocumentContent, saveDocumentChunks } = await import(
          "../services/tauriBridge"
        );
        const { indexDocument } = await import("../services/pythonClient");
        const content = await getDocumentContent(kbId, doc.id);
        const result = await indexDocument({
          kb_id: kbId,
          doc_id: doc.id,
          doc_name: doc.name,
          markdown_content: content.markdown,
        });
        await saveDocumentChunks(kbId, doc.id, result.chunk_count, result.embedding_model, result.embedding_dim);
        set((s) => ({
          documents: s.documents.map((d) =>
            d.id === doc.id ? { ...d, chunk_count: result.chunk_count, embedding_model: result.embedding_model } : d
          ),
          indexingIds: new Set([...s.indexingIds].filter((id) => id !== doc.id)),
        }));
      } catch (e) {
        console.error("Auto-index failed:", e);
        set((s) => ({
          indexingIds: new Set([...s.indexingIds].filter((id) => id !== doc.id)),
        }));
      }
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
