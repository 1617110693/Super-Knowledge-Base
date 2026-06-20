import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useKBStore } from "../../stores/useKBStore";
import { useI18n } from "../../i18n";
import { indexDocument } from "../../services/pythonClient";
import {
  FileText, Layers, Upload, Trash2, Loader2,
  CheckCircle, XCircle, Clock, Eye, FolderOpen,
  Search, Database, Pencil, RefreshCw, Check, FolderSearch, Copy,
} from "lucide-react";
import type { Document } from "../../types";
import { ConfirmDialog } from "../common/ConfirmDialog";

const STATUS_MAP: Record<string, { icon: React.ReactNode; labelKey: "parse.pending" | "parse.parsing" | "parse.done" | "parse.failed" }> = {
  pending: { icon: <Clock className="w-4 h-4 text-yellow-500" />, labelKey: "parse.pending" },
  parsing: { icon: <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />, labelKey: "parse.parsing" },
  done: { icon: <CheckCircle className="w-4 h-4 text-green-500" />, labelKey: "parse.done" },
  failed: { icon: <XCircle className="w-4 h-4 text-red-500" />, labelKey: "parse.failed" },
};

/** Combined KB workspace: overview stats + document management + search entry */
export function KBSettings() {
  const { kbId } = useParams<{ kbId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { knowledgeBases, documents, loadKBs, loadDocuments, uploadDocument, deleteDocument, refreshDocument, setActiveKB, updateKB, copyKB, reindexDocument, reindexAll, indexingIds } = useKBStore();
  const [dragOver, setDragOver] = useState(false);
  const uploadingRef = useRef(false);
  const [indexing, setIndexing] = useState<Record<string, boolean>>({});
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<{ docId: string; docName: string } | null>(null);

  // ── Rename KB ──
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  useEffect(() => { loadKBs(); }, []);
  useEffect(() => {
    if (kbId) {
      setLoadingDocs(true);
      loadDocuments(kbId).finally(() => setLoadingDocs(false));
    }
  }, [kbId]);

  const kb = knowledgeBases.find((k) => k.id === kbId);
  useEffect(() => { if (kb) setActiveKB(kb); }, [kb]);

  // Poll MinerU parsing + trigger index when parsing finishes
  const indexedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!kbId) return;
    const interval = setInterval(async () => {
      // Refresh docs still being parsed by MinerU
      for (const doc of documents) {
        if (doc.parse_status === "parsing") {
          refreshDocument(kbId, doc.id);
        }
      }
      // When parsing finishes, trigger index once
      for (const doc of documents) {
        if (
          doc.parse_status === "done" &&
          doc.chunk_count === 0 &&
          !indexedRef.current.has(doc.id)
        ) {
          indexedRef.current.add(doc.id);
          setIndexing((p) => ({ ...p, [doc.id]: true }));
          try {
            const { getDocumentContent, saveDocumentChunks } = await import(
              "../../services/tauriBridge"
            );
            const content = await getDocumentContent(kbId, doc.id);
            const result = await indexDocument({
              kb_id: kbId,
              doc_id: doc.id,
              doc_name: doc.name,
              markdown_content: content.markdown,
            });
            await saveDocumentChunks(kbId, doc.id, result.chunk_count, result.embedding_model, result.embedding_dim);
            useKBStore.setState((s) => ({
              documents: s.documents.map((d) =>
                d.id === doc.id ? { ...d, chunk_count: result.chunk_count, embedding_model: result.embedding_model } : d
              ),
              knowledgeBases: s.knowledgeBases.map((k) =>
                k.id === kbId ? { ...k, embedding_model: result.embedding_model, embedding_dim: result.embedding_dim } : k
              ),
            }));
          } catch (e) {
            console.error("Auto-index failed:", e);
            indexedRef.current.delete(doc.id);
          }
          setIndexing((p) => ({ ...p, [doc.id]: false }));
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [documents, kbId, refreshDocument]);

  // ── Edit KB name / description ──
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");

  const startRename = () => {
    if (kb) {
      setNameDraft(kb.name);
      setEditingName(true);
    }
  };

  const commitRename = async () => {
    if (kbId && nameDraft.trim() && nameDraft.trim() !== kb?.name) {
      await updateKB(kbId, nameDraft.trim(), null);
    }
    setEditingName(false);
  };

  const startEditDesc = () => {
    if (kb) {
      setDescDraft(kb.description || "");
      setEditingDesc(true);
    }
  };

  const commitDesc = async () => {
    const newDesc = descDraft.trim();
    if (kbId && newDesc !== (kb?.description || "")) {
      await updateKB(kbId, null, newDesc || null);
    }
    setEditingDesc(false);
  };

  // ── Upload ──

  const doUpload = useCallback(async (filePath: string) => {
    if (!kbId) return;
    uploadingRef.current = true;
    try {
      await uploadDocument(kbId, filePath);
    } catch (e) { console.error(e); }
    uploadingRef.current = false;
  }, [kbId, uploadDocument]);

  const handleUploadClick = useCallback(async () => {
    if (!kbId) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [{ name: t("docs.uploadFilter"), extensions: ["pdf","doc","docx","ppt","pptx","xls","xlsx","png","jpg","jpeg","webp","gif","bmp","html","md","markdown","txt"] }],
      });
      if (selected) {
        const files = Array.isArray(selected) ? selected : [selected];
        for (const f of files) await doUpload(f as string);
      }
    } catch (e) { console.error(e); }
  }, [kbId, doUpload, t]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      // @ts-expect-error Tauri adds `path` to File objects
      const path = files[i].path as string | undefined;
      if (path) doUpload(path);
    }
  }, [doUpload]);

  // ── Actions ──

  const handleDeleteConfirm = async () => {
    if (kbId && deleteTarget) {
      await deleteDocument(kbId, deleteTarget.docId);
      setDeleteTarget(null);
    }
  };

  const handleReindexDoc = async (doc: Document) => {
    if (!kbId) return;
    await reindexDocument(kbId, doc.id, doc.name);
  };

  const handleReindexAll = async () => {
    if (!kbId) return;
    await reindexAll(kbId);
  };

  const handleOpenInExplorer = async (doc: Document) => {
    if (!kbId) return;
    try {
      const { revealDocumentInExplorer } = await import("../../services/tauriBridge");
      await revealDocumentInExplorer(kbId, doc.id);
    } catch (e) {
      console.error("Failed to open in explorer:", e);
    }
  };

  // ── Render ──

  if (!kb) {
    return <div className="p-6 text-center text-muted-foreground">{t("overview.notFound")}</div>;
  }

  const doneCount = documents.filter((d) => d.parse_status === "done").length;
  const totalChunks = documents.reduce((sum, d) => sum + d.chunk_count, 0);
  const hasIndexedDocs = documents.some((d) => d.chunk_count > 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 pb-4 border-b bg-card/50 shrink-0">
        <div className="flex items-center gap-4">
          <FolderOpen className="w-10 h-10 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setEditingName(false); }}
                  onBlur={commitRename}
                  className="text-2xl font-bold bg-background border rounded-lg px-3 py-1 w-full max-w-md outline-none ring-1 ring-primary"
                />
                <button onClick={commitRename} className="p-1.5 hover:bg-green-50 rounded-md text-green-600" title={t("kb.rename")}>
                  <Check className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <h2 className="text-2xl font-bold truncate flex items-center gap-2">
                {kb.name}
                <button onClick={startRename} className="p-1 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground" title={t("kb.rename")}>
                  <Pencil className="w-4 h-4" />
                </button>
              </h2>
            )}
            {editingDesc ? (
              <div className="flex items-center gap-2 mt-1">
                <input
                  autoFocus
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") commitDesc(); if (e.key === "Escape") setEditingDesc(false); }}
                  onBlur={commitDesc}
                  placeholder={t("kb.description")}
                  className="text-sm bg-background border rounded-lg px-2 py-1 w-full max-w-md outline-none ring-1 ring-primary"
                />
                <button onClick={commitDesc} className="p-1 hover:bg-green-50 rounded-md text-green-600 shrink-0" title={t("kb.rename")}>
                  <Check className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm truncate flex items-center gap-1">
                {kb.description || <span className="text-muted-foreground/40 italic">{t("kb.addDescription")}</span>}
                <button onClick={startEditDesc} className="p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground" title={t("kb.editDescription")}>
                  <Pencil className="w-3 h-3" />
                </button>
              </p>
            )}
            {kb.embedding_model && (
              <p className="text-xs text-muted-foreground mt-0.5">
                <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium">{kb.embedding_model}</span>
                {kb.embedding_dim > 0 && <span className="ml-1">dim: {kb.embedding_dim}</span>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hasIndexedDocs && (
              <button
                onClick={handleReindexAll}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg text-sm font-medium hover:bg-amber-100 transition-colors"
                title={t("docs.reindexAll")}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                {t("docs.reindexAll")}
              </button>
            )}
            <button
              onClick={async () => {
                if (kbId) {
                  await copyKB(kbId);
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm font-medium hover:bg-muted transition-colors"
              title={t("kb.copy")}
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => navigate(`/kb/${kbId}/search`)}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90"
            >
              <Search className="w-4 h-4" />{t("nav.search")}
            </button>
          </div>
        </div>

        {/* Stats pills */}
        <div className="flex gap-3 mt-4">
          {[
            { icon: FileText, label: t("overview.documents"), value: kb.document_count },
            { icon: CheckCircle, label: t("parse.done"), value: doneCount },
            { icon: Layers, label: t("overview.chunks"), value: totalChunks },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/60 text-sm">
              <Icon className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">{label}</span>
              <span className="font-semibold">{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Document area */}
      <div className="flex-1 overflow-auto p-6">
        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={handleUploadClick}
          className={`mb-4 border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30"
          }`}
        >
          <Upload className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm font-medium">{t("docs.upload")}</p>
          <p className="text-xs text-muted-foreground mt-1">{t("docs.emptyHint")}</p>
        </div>

        {/* Document list */}
        {documents.length === 0 ? (
          <div className="text-center py-12">
            {uploadingRef.current || loadingDocs ? (
              <>
                <Loader2 className="w-8 h-8 text-primary mx-auto mb-3 animate-spin" />
                <p className="text-sm font-medium text-muted-foreground">{t("docs.uploading")}</p>
                <p className="text-xs text-muted-foreground mt-1">{loadingDocs ? t("docs.loadingHint") : t("docs.parsingHint")}</p>
              </>
            ) : (
              <>
                <Upload className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">{t("docs.emptyHint")}</p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            {documents.map((doc) => {
              const status = STATUS_MAP[doc.parse_status] || STATUS_MAP.pending;
              const isParseFailed = doc.parse_status === "failed";
              const isIndexing = indexing[doc.id] || indexingIds.has(doc.id);
              const isIndexed = !isIndexing && doc.chunk_count > 0;
              return (
                <div
                  key={doc.id}
                  className={`flex items-center justify-between p-3 rounded-lg border bg-card transition-colors ${
                    isParseFailed ? "border-red-200 bg-red-50/30" : ""
                  }`}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <FileText className="w-5 h-5 text-primary shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{doc.name}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                        <span>{(doc.file_size / 1024).toFixed(1)} KB</span>
                        <span>·</span>
                        <span className="flex items-center gap-1">{status.icon}{t(status.labelKey)}</span>
                        {doc.chunk_count > 0 && (
                          <>
                            <span>·</span>
                            <span>{doc.chunk_count} {t("kb.chunks")}</span>
                          </>
                        )}
                        {isParseFailed && doc.parse_error && (
                          <>
                            <span>·</span>
                            <span className="text-red-500 truncate max-w-[200px]">{doc.parse_error}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 ml-3 shrink-0">
                    {/* Indexing in progress */}
                    {isIndexing && (
                      <span className="flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-600 rounded text-xs font-medium">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {t("docs.indexing")}
                      </span>
                    )}
                    {/* Indexed */}
                    {isIndexed && (
                      <span className="flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium">
                        <Database className="w-3 h-3" />
                        {doc.chunk_count} {t("kb.chunks")}
                      </span>
                    )}
                    {/* Done parsing but no content (empty doc or index error) */}
                    {!isIndexing && doc.parse_status === "done" && doc.chunk_count === 0 && (
                      <span className="px-2 py-1 bg-muted text-muted-foreground rounded text-xs">
                        {t("docs.empty")}
                      </span>
                    )}
                    {/* Re-index button */}
                    {isIndexed && (
                      <button
                        onClick={() => handleReindexDoc(doc)}
                        className="p-1.5 hover:bg-amber-50 rounded-md text-muted-foreground hover:text-amber-600"
                        title={t("docs.reindex")}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => handleOpenInExplorer(doc)}
                      className="p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground"
                      title="Open file location"
                    >
                      <FolderSearch className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => navigate(`/kb/${kbId}/documents/${doc.id}`)}
                      className="p-1.5 hover:bg-muted rounded-md"
                      title={t("docs.preview")}
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget({ docId: doc.id, docName: doc.name })}
                      className="p-1.5 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500"
                      title={t("docs.delete")}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("docs.delete")}
        message={`${t("docs.delete")}: ${deleteTarget?.docName ?? ""}`}
        confirmLabel={t("docs.delete")}
        cancelLabel={t("kb.cancel")}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

    </div>
  );
}
