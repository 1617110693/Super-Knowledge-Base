import { create } from "zustand";
import type { KnowledgeBase, Document } from "../types";
import * as tauriBridge from "../services/tauriBridge";

interface KBState {
  knowledgeBases: KnowledgeBase[];
  activeKB: KnowledgeBase | null;
  documents: Document[];
  loading: boolean;
  error: string | null;

  loadKBs: () => Promise<void>;
  loadDocuments: (kbId: string) => Promise<void>;
  createKB: (name: string, description: string) => Promise<void>;
  deleteKB: (kbId: string) => Promise<void>;
  setActiveKB: (kb: KnowledgeBase | null) => void;
  uploadDocument: (kbId: string, filePath: string) => Promise<void>;
  deleteDocument: (kbId: string, docId: string) => Promise<void>;
  refreshDocument: (kbId: string, docId: string) => Promise<void>;
}

export const useKBStore = create<KBState>((set, get) => ({
  knowledgeBases: [],
  activeKB: null,
  documents: [],
  loading: false,
  error: null,

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

  deleteKB: async (kbId: string) => {
    await tauriBridge.deleteKB(kbId);
    set((s) => ({
      knowledgeBases: s.knowledgeBases.filter((k) => k.id !== kbId),
      activeKB: s.activeKB?.id === kbId ? null : s.activeKB,
    }));
  },

  setActiveKB: (kb) => set({ activeKB: kb, documents: [] }),

  uploadDocument: async (kbId: string, filePath: string) => {
    const doc = await tauriBridge.uploadDocument(kbId, filePath);
    set((s) => ({ documents: [doc, ...s.documents] }));
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
}));
