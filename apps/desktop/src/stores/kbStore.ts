import { defineStore } from "pinia";
import { ref } from "vue";
import type { KnowledgeBase, Document } from "@/types";
import * as tauriBridge from "@/services/tauriBridge";

export type ViewMode = "card" | "compact" | "grid";
export type SortMode = "manual" | "name-asc" | "name-desc" | "date-asc" | "date-desc";

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

export const useKBStore = defineStore("kb", () => {
  const knowledgeBases = ref<KnowledgeBase[]>([]);
  const activeKB = ref<KnowledgeBase | null>(null);
  const documents = ref<Document[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const indexingProgress = ref<Record<string, { percent: number; stage: string; current: number; total: number; taskId?: string; vlm_status?: string; vlm_current?: number; vlm_total?: number; vlm_error?: string; error?: string }>>({});
  const viewMode = ref<ViewMode>((localStorage.getItem("kbViewMode") as ViewMode) || "card");
  const sortMode = ref<SortMode>((localStorage.getItem("kbSortMode") as SortMode) || "manual");

  async function loadKBs() {
    loading.value = true;
    error.value = null;
    try {
      knowledgeBases.value = await tauriBridge.listKBs();
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function loadDocuments(kbId: string) {
    loading.value = true;
    error.value = null;
    documents.value = [];
    try {
      const docs = await tauriBridge.listDocuments(kbId);
      documents.value = groupParts(docs);
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function createKB(name: string, description: string) {
    const kb = await tauriBridge.createKB(name, description);
    knowledgeBases.value = [...knowledgeBases.value, kb];
  }

  async function updateKB(kbId: string, name: string | null, description: string | null) {
    const updated = await tauriBridge.updateKB(kbId, name, description);
    knowledgeBases.value = knowledgeBases.value.map((k) =>
      k.id === kbId ? { ...k, ...updated } : k
    );
    if (activeKB.value?.id === kbId) {
      activeKB.value = { ...activeKB.value, ...updated };
    }
  }

  async function copyKB(kbId: string) {
    const kb = await tauriBridge.copyKB(kbId);
    knowledgeBases.value = [...knowledgeBases.value, kb];
    try {
      const { copyKbLanceDb } = await import("@/services/pythonClient");
      await copyKbLanceDb(kbId, kb.id);
    } catch (e) {
      console.error("LanceDB copy failed (docs still copied):", e);
    }
  }

  async function deleteKB(kbId: string) {
    await tauriBridge.deleteKB(kbId);
    knowledgeBases.value = knowledgeBases.value.filter((k) => k.id !== kbId);
    if (activeKB.value?.id === kbId) {
      activeKB.value = null;
    }
  }

  function setActiveKB(kb: KnowledgeBase | null) {
    activeKB.value = kb;
  }

  async function uploadDocument(kbId: string, filePath: string, folderPath?: string | null) {
    // 1. Check embedding model consistency
    const kb = knowledgeBases.value.find((k) => k.id === kbId);
    if (kb && kb.embedding_model) {
      const settings = await tauriBridge.getSettings();
      const effectiveModel = settings.use_local_embedding
        ? (settings.local_embedding_model || "local").replace(/\.gguf$/i, "").split(/[/\\]/).pop() || "local"
        : settings.embedding_model;
      if (effectiveModel && effectiveModel !== kb.embedding_model) {
        throw new Error(
          `Embedding model mismatch: this knowledge base uses "${kb.embedding_model}" (dim ${kb.embedding_dim}), but current settings use "${effectiveModel}". Please switch the embedding model in settings or use "Re-index All" to rebind.`
        );
      }
    }

    // 2. Upload (may split large PDFs into parts)
    const uploadResult = await tauriBridge.uploadDocument(kbId, filePath, folderPath ?? null);
    const doc = uploadResult.document;
    const allDocs = [doc, ...uploadResult.parts];
    documents.value = groupParts([...allDocs, ...documents.value]);

    // 3. Determine which docs need parsing (skip main doc if it has split parts)
    const docsToParse = allDocs.filter(d => {
      return !allDocs.some(p => p.parent_doc_id === d.id);
    });
    const parseOrder = [...docsToParse].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    );

    // 4. Parse (parallel) + index (sequential) in the BACKGROUND
    (async () => {
      // Parallel parse
      await Promise.all(parseOrder.map(async (d) => {
        try {
          await tauriBridge.startParsing(kbId, d.id);
          // Poll parse status + progress simultaneously
          const deadline = Date.now() + 15 * 60 * 1000;
          while (Date.now() < deadline) {
            const parsed = await tauriBridge.pollParseStatus(kbId, d.id);
            documents.value = updateDocInTree(documents.value, d.id, parsed);
            if (parsed.parse_status === "done" || parsed.parse_status === "failed") break;
            // Also fetch progress percentage from Rust side
            try {
              const { getParseProgress } = await import("@/services/tauriBridge");
              const p = await getParseProgress(kbId, d.id);
              if (p) {
                indexingProgress.value = { ...indexingProgress.value, [d.id]: { percent: p.percent, stage: p.stage, current: 0, total: 100 } };
              }
            } catch { /* progress not available */ }
            await new Promise(r => setTimeout(r, 2000));
          }
          // Clean up parse progress so indexing can start
          const { [d.id]: _, ...rest } = indexingProgress.value;
          indexingProgress.value = rest;
        } catch { /* parse failed, keep original doc */ }
      }));

      // Parallel index — all parts can run concurrently since:
      // 1) Each part has its own doc_id (no LanceDB collision)
      // 2) Page offset computation reads PDF files from disk, not index results
      // 3) VLM background phase is already decoupled from the main pipeline
      await Promise.all(parseOrder.map(async (d) => {
        const flat = documents.value.flatMap(doc =>
          doc.parts?.length ? [doc, ...doc.parts] : [doc]
        );
        const latest = flat.find(doc => doc.id === d.id);
        if (!latest || latest.parse_status !== "done") return;
        if (indexingProgress.value[d.id]?.stage !== "error") {
          if (indexingProgress.value[d.id]) return;
          if (latest.chunk_count > 0) return;
        }

        indexingProgress.value = { ...indexingProgress.value, [d.id]: { percent: 0, stage: "starting", current: 0, total: 0 } };
        try {
          const { indexDocument, waitForIndex } = await import("@/services/pythonClient");
          const content = await tauriBridge.getDocumentContent(kbId, d.id);
          const { task_id } = await indexDocument({
            kb_id: kbId,
            doc_id: d.id,
            doc_name: d.name,
            markdown_content: content.markdown,
          });
          indexingProgress.value = { ...indexingProgress.value, [d.id]: { ...indexingProgress.value[d.id], taskId: task_id } };
          let lastUpdate = 0;
          const result = await waitForIndex(task_id, (p) => {
            const now = Date.now();
            if (now - lastUpdate < 800) return;
            lastUpdate = now;
            indexingProgress.value = { ...indexingProgress.value, [d.id]: { ...indexingProgress.value[d.id], percent: p.percent, stage: p.stage, current: p.current, total: p.total, vlm_status: p.vlm_status, vlm_current: p.vlm_current, vlm_total: p.vlm_total, vlm_error: p.vlm_error } };
          });
          await tauriBridge.saveDocumentChunks(kbId, d.id, result.chunk_count!, result.embedding_model!, result.embedding_dim!);
          documents.value = updateDocInTree(documents.value, d.id, {
            chunk_count: result.chunk_count,
            embedding_model: result.embedding_model,
          } as Partial<Document>);
          knowledgeBases.value = knowledgeBases.value.map((k) =>
            k.id === kbId ? { ...k, embedding_model: result.embedding_model || "", embedding_dim: result.embedding_dim || 0 } : k
          );

          // Phase 2: VLM post-processing (runs in background on backend)
          if (result.vlm_pending && result.vlm_pending > 0) {
            try {
              const { waitForVlmComplete } = await import("@/services/pythonClient");
              await waitForVlmComplete(task_id, (v) => {
                const now = Date.now();
                if (now - lastUpdate < 800) return;
                lastUpdate = now;
                indexingProgress.value = { ...indexingProgress.value, [d.id]: {
                  ...indexingProgress.value[d.id],
                  percent: v.vlm_total > 0 ? Math.round((v.vlm_current / v.vlm_total) * 100) : 0,
                  stage: "vlm",
                  current: v.vlm_current, total: v.vlm_total,
                  vlm_status: v.vlm_status, vlm_current: v.vlm_current,
                  vlm_total: v.vlm_total, vlm_error: v.vlm_error,
                }};
              });
            } catch (vlmErr) {
              console.error("VLM background failed:", vlmErr);
            }
          }
          const { [d.id]: _, ...rest } = indexingProgress.value;
          indexingProgress.value = rest;
        } catch (e) {
          console.error("Auto-index failed:", e);
          indexingProgress.value = { ...indexingProgress.value, [d.id]: { ...indexingProgress.value[d.id], stage: "error", error: String(e), percent: 0 } };
        }
      }));
      documents.value = groupParts(documents.value);
    })().catch(e => console.error("parse+index background flow failed:", e));
  }

  async function deleteDocument(kbId: string, docId: string) {
    await tauriBridge.deleteDocument(kbId, docId);
    documents.value = documents.value
      .filter(d => d.id !== docId)
      .map(d => {
        if (d.parts?.length) {
          return { ...d, parts: d.parts.filter(p => p.id !== docId) };
        }
        return d;
      });
  }

  async function refreshDocument(kbId: string, docId: string) {
    const doc = await tauriBridge.pollParseStatus(kbId, docId);
    documents.value = updateDocInTree(documents.value, docId, doc);
  }

  async function reindexDocument(kbId: string, docId: string, docName: string) {
    indexingProgress.value = { ...indexingProgress.value, [docId]: { percent: 0, stage: "starting", current: 0, total: 0 } };
    try {
      const { indexDocument, waitForIndex } = await import("@/services/pythonClient");
      const content = await tauriBridge.getDocumentContent(kbId, docId);
      const { task_id } = await indexDocument({
        kb_id: kbId,
        doc_id: docId,
        doc_name: docName,
        markdown_content: content.markdown,
      });
      indexingProgress.value = { ...indexingProgress.value, [docId]: { ...indexingProgress.value[docId], taskId: task_id } };
      let lastUpdate = 0;
      const result = await waitForIndex(task_id, (p) => {
        const now = Date.now();
        if (now - lastUpdate < 800) return;
        lastUpdate = now;
        indexingProgress.value = { ...indexingProgress.value, [docId]: { ...indexingProgress.value[docId], percent: p.percent, stage: p.stage, current: p.current, total: p.total, vlm_status: p.vlm_status, vlm_current: p.vlm_current, vlm_total: p.vlm_total, vlm_error: p.vlm_error } };
      });
      await tauriBridge.saveDocumentChunks(kbId, docId, result.chunk_count!, result.embedding_model!, result.embedding_dim!);
      await loadKBs();
      documents.value = updateDocInTree(documents.value, docId, {
        chunk_count: result.chunk_count,
        embedding_model: result.embedding_model,
      } as Partial<Document>);

      if (result.vlm_pending && result.vlm_pending > 0) {
        try {
          const { waitForVlmComplete } = await import("@/services/pythonClient");
          await waitForVlmComplete(task_id, (v) => {
            const now = Date.now();
            if (now - lastUpdate < 800) return;
            lastUpdate = now;
            indexingProgress.value = { ...indexingProgress.value, [docId]: {
              ...indexingProgress.value[docId],
              percent: v.vlm_total > 0 ? Math.round((v.vlm_current / v.vlm_total) * 100) : 0,
              stage: "vlm", current: v.vlm_current, total: v.vlm_total,
              vlm_status: v.vlm_status, vlm_current: v.vlm_current,
              vlm_total: v.vlm_total, vlm_error: v.vlm_error,
            }};
          });
        } catch (vlmErr) {
          console.error("VLM background failed:", vlmErr);
        }
      }
      const { [docId]: _, ...rest } = indexingProgress.value;
      indexingProgress.value = rest;
    } catch (e) {
      console.error("Re-index failed:", e);
      // Keep progress entry with error info so user can see it in the dialog
      indexingProgress.value = { ...indexingProgress.value, [docId]: { ...indexingProgress.value[docId], stage: "error", error: String(e), percent: 0 } };
    }
  }

  async function reindexAll(kbId: string) {
    try {
      const { backupKb } = await import("@/services/pythonClient");
      await backupKb(kbId);
    } catch (e) {
      console.error("Backup before reindex failed:", e);
    }
    const flatDocs = documents.value.flatMap(d =>
      d.parts?.length ? [d, ...d.parts] : [d]
    );
    for (const doc of flatDocs) {
      if (doc.parse_status === "done") {
        await reindexDocument(kbId, doc.id, doc.name);
      }
    }
  }

  async function togglePinKB(kbId: string) {
    knowledgeBases.value = await tauriBridge.togglePinKB(kbId);
  }

  async function reorderKBs(orderedIds: string[]) {
    const prevKBs = knowledgeBases.value;
    const reordered = orderedIds.map(id => prevKBs.find(k => k.id === id)!).filter(Boolean);
    knowledgeBases.value = reordered;
    knowledgeBases.value = await tauriBridge.reorderKBs(orderedIds);
  }

  function setViewMode(mode: ViewMode) {
    localStorage.setItem("kbViewMode", mode);
    viewMode.value = mode;
  }

  function setSortMode(mode: SortMode) {
    localStorage.setItem("kbSortMode", mode);
    sortMode.value = mode;
  }

  function getSortedKBs(): KnowledgeBase[] {
    const pinned = knowledgeBases.value.filter(k => k.pinned);
    const unpinned = knowledgeBases.value.filter(k => !k.pinned);

    const sortFn = (a: KnowledgeBase, b: KnowledgeBase): number => {
      switch (sortMode.value) {
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
          return 0;
      }
    };

    return [...pinned.sort(sortFn), ...unpinned.sort(sortFn)];
  }

  return {
    knowledgeBases, activeKB, documents, loading, error, indexingProgress, viewMode, sortMode,
    loadKBs, loadDocuments, createKB, updateKB, copyKB, deleteKB, setActiveKB,
    uploadDocument, deleteDocument, refreshDocument, reindexDocument, reindexAll,
    togglePinKB, reorderKBs, setViewMode, setSortMode, getSortedKBs,
  };
});
