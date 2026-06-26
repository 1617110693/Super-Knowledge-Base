import { create } from "zustand";
import type { KnowledgeBase, Document } from "../types";
import * as tauriBridge from "../services/tauriBridge";

export type ViewMode = "card" | "compact" | "grid";
export type SortMode = "manual" | "name-asc" | "name-desc" | "date-asc" | "date-desc";

interface KBState {
  knowledgeBases: KnowledgeBase[];
  activeKB: KnowledgeBase | null;
  documents: Document[];
  loading: boolean;
  error: string | null;
  indexingIds: Set<string>;
  viewMode: ViewMode;
  sortMode: SortMode;

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
  togglePinKB: (kbId: string) => Promise<void>;
  reorderKBs: (orderedIds: string[]) => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
  setSortMode: (mode: SortMode) => void;
  getSortedKBs: () => KnowledgeBase[];
}

// Group child documents (split parts) under their parents in the flat list.
// Parts are sorted by name for consistent ordering.
function groupParts(docs: Document[]): Document[] {
  const partDocs = docs.filter(d => d.parent_doc_id);
  const parentDocs = docs.filter(d => !d.parent_doc_id);
  return parentDocs.map(parent => {
    const parts = partDocs
      .filter(p => p.parent_doc_id === parent.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    return parts.length > 0 ? { ...parent, parts } : parent;
  });
}

// Recursively find a document by ID in a tree (including nested parts) and merge updates.
function updateDocInTree(docs: Document[], id: string, updates: Partial<Document>): Document[] {
  return docs.map(doc => {
    if (doc.id === id) return { ...doc, ...updates };
    if (doc.parts?.length) {
      return { ...doc, parts: updateDocInTree(doc.parts, id, updates) };
    }
    return doc;
  });
}

export const useKBStore = create<KBState>((set, get) => ({
  knowledgeBases: [],
  activeKB: null,
  documents: [],
  loading: false,
  error: null,
  indexingIds: new Set(),
  viewMode: (localStorage.getItem("kbViewMode") as ViewMode) || "card",
  sortMode: (localStorage.getItem("kbSortMode") as SortMode) || "manual",

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
      set({ documents: groupParts(docs), loading: false });
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
    // Keep flat list during processing so per-doc status updates work;
    // will regroup after the parse+index loop.
    set((s) => ({ documents: groupParts([...allDocs, ...s.documents]) }));

    // 3. Parse each document (skip main doc if it has parts — parts are parsed instead)
    const docsToParse = allDocs.filter(doc => {
      // If this doc has child parts, skip parsing the main doc (it's the original large file)
      if (allDocs.some(p => p.parent_doc_id === doc.id)) return false;
      return true;
    });
    for (const d of docsToParse) {
      try {
        await tauriBridge.startParsing(kbId, d.id);
        const parsed = await tauriBridge.pollParseStatus(kbId, d.id);
        set((s) => ({
          documents: updateDocInTree(s.documents, d.id, parsed),
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
              documents: updateDocInTree(s.documents, d.id, {
                chunk_count: result.chunk_count,
                embedding_model: result.embedding_model,
              } as Partial<Document>),
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
    // Re-group after all parsing completes
    set((s) => ({ documents: groupParts(s.documents) }));
  },

  deleteDocument: async (kbId: string, docId: string) => {
    await tauriBridge.deleteDocument(kbId, docId);
    set((s) => {
      // Remove from top level or from nested parts
      const docs = s.documents
        .filter(d => d.id !== docId)
        .map(d => {
          if (d.parts?.length) {
            return { ...d, parts: d.parts.filter(p => p.id !== docId) };
          }
          return d;
        });
      return { documents: docs };
    });
  },

  refreshDocument: async (kbId: string, docId: string) => {
    const doc = await tauriBridge.pollParseStatus(kbId, docId);
    set((s) => ({
      documents: updateDocInTree(s.documents, docId, doc),
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
      // Reload KBs from registry to get updated chunk_count totals
      await get().loadKBs();
      set((s) => ({
        documents: updateDocInTree(s.documents, docId, {
          chunk_count: result.chunk_count,
          embedding_model: result.embedding_model,
        } as Partial<Document>),
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

  togglePinKB: async (kbId: string) => {
    const kbs = await tauriBridge.togglePinKB(kbId);
    set({ knowledgeBases: kbs });
  },

  reorderKBs: async (orderedIds: string[]) => {
    // Optimistic update
    const prevKBs = get().knowledgeBases;
    const reordered = orderedIds.map(id => prevKBs.find(k => k.id === id)!).filter(Boolean);
    set({ knowledgeBases: reordered });
    // Persist
    const kbs = await tauriBridge.reorderKBs(orderedIds);
    set({ knowledgeBases: kbs });
  },

  setViewMode: (mode: ViewMode) => {
    localStorage.setItem("kbViewMode", mode);
    set({ viewMode: mode });
  },

  setSortMode: (mode: SortMode) => {
    localStorage.setItem("kbSortMode", mode);
    set({ sortMode: mode });
  },

  getSortedKBs: () => {
    const { knowledgeBases, sortMode } = get();
    // Split into pinned / unpinned groups; pinned always comes first
    const pinned = knowledgeBases.filter(k => k.pinned);
    const unpinned = knowledgeBases.filter(k => !k.pinned);

    const sortFn = (a: KnowledgeBase, b: KnowledgeBase): number => {
      switch (sortMode) {
        case "name-asc":
          return a.name.localeCompare(b.name);
        case "name-desc":
          return b.name.localeCompare(a.name);
        case "date-asc":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "date-desc":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "manual":
        default:
          return 0; // preserve registry order
      }
    };

    const sortedPinned = [...pinned].sort(sortFn);
    const sortedUnpinned = [...unpinned].sort(sortFn);
    return [...sortedPinned, ...sortedUnpinned];
  },
}));
