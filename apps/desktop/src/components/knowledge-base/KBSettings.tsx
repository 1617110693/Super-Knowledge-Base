import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useKBStore } from "../../stores/useKBStore";
import { useI18n } from "../../i18n";
import { indexDocument } from "../../services/pythonClient";
import {
  FileText, Layers, Upload, Trash2, Loader2,
  CheckCircle, XCircle, Clock, Eye,
  Search, Database, Pencil, RefreshCw, Check, FolderSearch, Copy, X, ArrowLeft,
  Plus, FolderOpen,
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
  const [deleteKBTarget, setDeleteKBTarget] = useState(false);
  const [errorDetailTarget, setErrorDetailTarget] = useState<string | null>(null);
  const [errorCopied, setErrorCopied] = useState(false);
  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [pathDocMenu, setPathDocMenu] = useState<string | null>(null);
  const [deletePathTarget, setDeletePathTarget] = useState<string | null>(null);
  const [disbandOnly, setDisbandOnly] = useState(false);

  // ── Rename KB ──
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showDescDialog, setShowDescDialog] = useState(false);

  useEffect(() => { loadKBs(); }, []);
  useEffect(() => {
    if (kbId) {
      setLoadingDocs(true);
      loadDocuments(kbId).finally(() => setLoadingDocs(false));
    }
  }, [kbId]);

  // Load paths when documents change
  useEffect(() => {
    if (kbId) {
      import("../../services/tauriBridge").then(({ listPaths }) => {
        listPaths(kbId).then(setPaths).catch(() => {});
      });
    }
  }, [kbId, documents]);

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
      await updateKB(kbId, null, newDesc);
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

  const handleDeleteKB = async () => {
    if (kbId) {
      await useKBStore.getState().deleteKB(kbId);
      navigate("/");
    }
    setDeleteKBTarget(false);
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

  const startDocRename = (doc: Document) => {
    setRenamingDocId(doc.id);
    setRenameDraft(doc.name);
  };

  const commitDocRename = async (doc: Document) => {
    if (!kbId || !renameDraft.trim() || renameDraft.trim() === doc.name) {
      setRenamingDocId(null);
      return;
    }
    try {
      const { renameDocument } = await import("../../services/tauriBridge");
      const updated = await renameDocument(kbId, doc.id, renameDraft.trim());
      useKBStore.setState((s) => ({
        documents: s.documents.map((d) => (d.id === doc.id ? { ...d, ...updated } : d)),
      }));
    } catch (e) {
      console.error("Rename failed:", e);
    }
    setRenamingDocId(null);
  };

  const handleMoveToPath = async (doc: Document, path: string | null) => {
    if (!kbId) return;
    try {
      const { setDocumentPath } = await import("../../services/tauriBridge");
      const updated = await setDocumentPath(kbId, doc.id, path);
      useKBStore.setState((s) => ({
        documents: s.documents.map((d) => (d.id === doc.id ? { ...d, ...updated } : d)),
      }));
    } catch (e) { console.error("Move to path failed:", e); }
    setPathDocMenu(null);
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    const name = newFolderName.trim();
    const fullPath = newFolderParent ? `${newFolderParent}/${name}` : name;
    setNewFolderName("");
    setShowNewFolder(false);
    setNewFolderParent(null);
    if (!paths.includes(fullPath)) {
      setPaths(prev => [...prev, fullPath].sort());
    }
  };

  const handleDeletePath = (path: string) => {
    setDeletePathTarget(path);
    setDisbandOnly(false);
  };

  const handleDeleteFolderConfirm = async () => {
    if (!kbId || !deletePathTarget) return;
    const path = deletePathTarget;
    try {
      if (disbandOnly) {
        // Just clear the path for all documents in this folder (and sub-folders)
        const { deletePath } = await import("../../services/tauriBridge");
        // Use the existing delete_path which sets path to null — but for disband,
        // we only want to clear path, not delete documents.
        // Wait, delete_path already only clears paths, it doesn't delete docs.
        await deletePath(kbId, path);
      } else {
        // Delete folder AND all documents inside
        const prefix = path + "/";
        const { deleteDocument } = await import("../../services/tauriBridge");
        const docs = documents.filter(d =>
          d.path === path || (d.path && d.path.startsWith(prefix))
        );
        for (const doc of docs) {
          await deleteDocument(kbId, doc.id);
        }
        const { deletePath } = await import("../../services/tauriBridge");
        await deletePath(kbId, path);
      }
      setPaths(prev => prev.filter(p => p !== path && !p.startsWith(path + "/")));
      if (selectedPath === path || selectedPath?.startsWith(path + "/")) setSelectedPath(null);
      await loadDocuments(kbId);
    } catch (e) { console.error("Delete folder failed:", e); }
    setDeletePathTarget(null);
  };

  // (folder tree rendered inline in the explorer list below)

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
          <button
            onClick={() => navigate("/")}
            className="p-1.5 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Back to Dashboard"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
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
              <h2 className="text-2xl font-bold break-words flex items-center gap-2">
                {kb.name}
                <button onClick={startRename} className="p-1 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground" title={t("kb.rename")}>
                  <Pencil className="w-4 h-4" />
                </button>
              </h2>
            )}
            {editingDesc ? (
              <div className="flex items-start gap-2 mt-1">
                <textarea
                  autoFocus
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitDesc(); } if (e.key === "Escape") setEditingDesc(false); }}
                  onBlur={commitDesc}
                  placeholder={t("kb.description")}
                  rows={2}
                  className="text-sm bg-background border rounded-lg px-2 py-1 w-full max-w-md outline-none ring-1 ring-primary resize-none"
                />
                <button onClick={commitDesc} className="p-1 hover:bg-green-50 rounded-md text-green-600 shrink-0" title={t("kb.rename")}>
                  <Check className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-1 mt-1 min-w-0">
                <p
                  onClick={() => kb.description && setShowDescDialog(true)}
                  className={`text-muted-foreground text-sm line-clamp-5 break-words min-w-0 flex-1 ${kb.description ? "cursor-pointer hover:text-foreground/80" : ""}`}
                  title={kb.description ? t("kb.editDescription") : undefined}
                >
                  {kb.description || <span className="text-muted-foreground/40 italic">{t("kb.addDescription")}</span>}
                </p>
                <button onClick={startEditDesc} className="p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground shrink-0" title={t("kb.editDescription")}>
                  <Pencil className="w-3 h-3" />
                </button>
              </div>
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
                  await loadKBs();
                  await loadDocuments(kbId);
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm font-medium hover:bg-muted transition-colors text-muted-foreground"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
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
              onClick={() => setDeleteKBTarget(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-red-200 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
              title={t("docs.delete")}
            >
              <Trash2 className="w-3.5 h-3.5" />
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

      {/* File Manager — Explorer-style single list */}
      <div className="flex-1 flex flex-col overflow-hidden rounded-xl border">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-card/50 shrink-0">
          <button onClick={handleUploadClick} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:opacity-90">
            <Upload className="w-3.5 h-3.5" /> {t("docs.upload")}
          </button>
          <button onClick={() => { setShowNewFolder(true); setNewFolderParent(selectedPath); }} className="flex items-center gap-1.5 px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted transition-colors">
            <Plus className="w-3.5 h-3.5" /> {t("docs.newFolder")}
          </button>
          <button onClick={async () => { if (kbId) { await loadKBs(); await loadDocuments(kbId); } }}
            className="p-1.5 hover:bg-muted rounded-md text-muted-foreground" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {/* Breadcrumb */}
          <div className="flex items-center gap-1 text-xs text-muted-foreground ml-2">
            <span onClick={() => setSelectedPath(null)} className="cursor-pointer hover:text-foreground">{t("docs.root")}</span>
            {selectedPath && selectedPath.split("/").map((seg, i, arr) => (
              <span key={i} className="flex items-center gap-1">
                <span>/</span>
                <span onClick={() => setSelectedPath(arr.slice(0, i + 1).join("/"))}
                  className={`cursor-pointer hover:text-foreground ${i === arr.length - 1 ? "text-foreground font-medium" : ""}`}>
                  {seg}
                </span>
              </span>
            ))}
          </div>
          <span className="text-xs text-muted-foreground ml-auto">
            {documents.filter(d => (d.path || null) === (selectedPath || null)).length} {t("docs.items")}
          </span>
        </div>

        {/* New folder input (inline) */}
        {showNewFolder && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 border rounded-md bg-card mx-2 mt-2">
            <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
            <input autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") { setShowNewFolder(false); setNewFolderParent(null); } }}
              placeholder={t("docs.folderName")}
              className="text-sm bg-background border rounded-md px-2 py-0.5 flex-1 outline-none focus:ring-1 focus:ring-primary" />
            <button onClick={handleCreateFolder} className="px-3 py-1 bg-primary text-primary-foreground rounded-md text-xs font-medium">{t("kb.createBtn")}</button>
            <button onClick={() => { setShowNewFolder(false); setNewFolderParent(null); }} className="px-3 py-1 border rounded-md text-xs">{t("kb.cancel")}</button>
          </div>
        )}

        {/* Explorer list */}
        <div className="flex-1 overflow-auto"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}>
          {documents.length === 0 && paths.length === 0 ? (
            <div className="text-center py-16">
              {uploadingRef.current || loadingDocs ? (
                <><Loader2 className="w-8 h-8 text-primary mx-auto mb-3 animate-spin" /><p className="text-sm text-muted-foreground">{t("docs.uploading")}</p></>
              ) : (
                <><FolderOpen className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" /><p className="text-sm text-muted-foreground">{t("docs.emptyHint")}</p></>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 p-2">
              {/* ".." parent directory */}
              {selectedPath && (
                <div className="flex items-center justify-between px-3 py-1.5 border rounded-md bg-card hover:border-primary/50 cursor-pointer transition-colors"
                  onClick={() => setSelectedPath(selectedPath.includes("/") ? selectedPath.split("/").slice(0, -1).join("/") : null)}>
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="text-sm text-muted-foreground">..</span>
                  </div>
                </div>
              )}
              {/* Sub-folders in current path */}
              {(() => {
                const prefix = selectedPath ? selectedPath + "/" : "";
                const folderNames = paths.filter(p => {
                  if (!p.startsWith(prefix)) return false;
                  const rest = p.slice(prefix.length);
                  return rest.length > 0 && !rest.includes("/");
                });
                return folderNames.map(fullPath => {
                  const name = fullPath.split("/").pop()!;
                  return (
                    <div key={`folder-${fullPath}`}
                      className="flex items-center justify-between px-3 py-1.5 border rounded-md bg-card hover:border-primary/50 cursor-pointer transition-colors"
                      onDoubleClick={() => setSelectedPath(fullPath)}>
                      <div className="flex items-center gap-1.5 min-w-0 flex-1" onClick={() => setSelectedPath(fullPath)}>
                        <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                        <span className="font-medium text-sm truncate">{name}</span>
                        <span className="text-[10px] text-muted-foreground/60">{t("docs.folderType")}</span>
                      </div>
                      <div className="flex items-center gap-1 ml-2 shrink-0">
                        <button onClick={(e) => { e.stopPropagation(); setDeletePathTarget(fullPath); }} className="p-1 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500" title={t("docs.deleteFolder")}><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  );
                });
              })()}
              {/* Documents in current path */}
              {documents
                .filter(doc => (doc.path || null) === (selectedPath || null))
                .map((doc) => {
                const status = STATUS_MAP[doc.parse_status] || STATUS_MAP.pending;
                const isParseFailed = doc.parse_status === "failed";
                const isIndexing = indexing[doc.id] || indexingIds.has(doc.id);
                const isIndexed = !isIndexing && doc.chunk_count > 0;
                return (
                <div key={doc.id}
                  className={`flex items-center justify-between px-3 py-1.5 border rounded-md bg-card hover:border-primary/50 transition-colors ${isParseFailed ? "border-red-200 bg-red-50/30" : ""}`}>
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <FileText className="w-4 h-4 text-primary shrink-0" />
                    {renamingDocId === doc.id ? (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <input autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") commitDocRename(doc); if (e.key === "Escape") { setRenamingDocId(null); } }}
                          onBlur={() => commitDocRename(doc)}
                          className="text-xs bg-background border rounded px-1.5 py-0.5 w-36 outline-none ring-1 ring-primary" />
                        <button onClick={() => commitDocRename(doc)} className="p-0.5 hover:bg-green-50 rounded text-green-600"><Check className="w-3 h-3" /></button>
                      </div>
                    ) : (
                      <span className="font-medium text-sm truncate cursor-pointer hover:text-primary" onClick={() => navigate(`/kb/${kbId}/documents/${doc.id}`)} title={doc.name}>{doc.name}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground/60 truncate hidden sm:inline">{(doc.file_size / 1024).toFixed(1)} KB · .{doc.file_type}</span>
                    <span className="text-[10px] text-muted-foreground/60">
                      {isIndexing ? <span className="text-blue-600">Idx</span>
                       : isParseFailed ? <span className="text-red-500 cursor-pointer hover:underline" onClick={(e) => { e.stopPropagation(); setErrorDetailTarget(doc.parse_error ?? null); }}>Failed</span>
                       : isIndexed ? <span className="text-green-600">{doc.chunk_count}c</span>
                       : <span>{t(status.labelKey)}</span>}
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5 ml-2 shrink-0">
                    {isIndexed && <button onClick={() => handleReindexDoc(doc)} className="p-0.5 hover:bg-amber-50 rounded text-muted-foreground hover:text-amber-600" title={t("docs.reindex")}><RefreshCw className="w-3 h-3" /></button>}
                    <div className="relative">
                      <button onClick={(e) => { e.stopPropagation(); setPathDocMenu(pathDocMenu === doc.id ? null : doc.id); }} className="p-0.5 hover:bg-muted rounded text-muted-foreground" title={t("docs.moveToPath")}><FolderOpen className="w-3 h-3" /></button>
                      {pathDocMenu === doc.id && (
                        <div className="absolute right-0 top-full mt-1 bg-card border rounded-lg shadow-lg z-20 min-w-[140px] py-1 max-h-40 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => handleMoveToPath(doc, null)} className={`w-full text-left px-2 py-1 text-xs hover:bg-muted ${!doc.path ? "font-medium text-primary" : ""}`}>{t("docs.noPath")}</button>
                          <div className="border-t my-0.5" />
                          {paths.map(p => (
                            <button key={p} onClick={() => handleMoveToPath(doc, p)} className={`w-full text-left px-2 py-1 text-xs hover:bg-muted ${doc.path === p ? "font-medium text-primary" : ""}`} style={{ paddingLeft: `${10 + (p.split("/").length - 1) * 10}px` }}>{p}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); startDocRename(doc); }} className="p-0.5 hover:bg-muted rounded text-muted-foreground" title={t("docs.rename")}><Pencil className="w-3 h-3" /></button>
                    <button onClick={() => handleOpenInExplorer(doc)} className="p-0.5 hover:bg-muted rounded text-muted-foreground" title={t("docs.openLocation")}><FolderSearch className="w-3 h-3" /></button>
                    <button onClick={() => setDeleteTarget({ docId: doc.id, docName: doc.name })} className="p-0.5 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500" title={t("docs.delete")}><Trash2 className="w-3 h-3" /></button>
                  </div>
                </div>
              );})}
            </div>
          )}
        </div>
      </div>

      {/* Delete doc confirm dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("docs.delete")}
        message={`${t("docs.delete")}: ${deleteTarget?.docName ?? ""}`}
        confirmLabel={t("docs.delete")}
        cancelLabel={t("kb.cancel")}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Delete KB confirm dialog */}
      <ConfirmDialog
        open={deleteKBTarget}
        title={t("kb.deleteConfirm")}
        message={t("kb.deleteConfirm")}
        confirmLabel={t("docs.delete")}
        cancelLabel={t("kb.cancel")}
        onConfirm={handleDeleteKB}
        onCancel={() => setDeleteKBTarget(false)}
      />

      {/* Delete folder confirm dialog */}
      {deletePathTarget !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDeletePathTarget(null)}>
          <div className="bg-card border rounded-xl shadow-xl max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="p-6">
              <h3 className="text-lg font-semibold mb-2">{t("docs.deleteFolder")}</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {t("docs.deleteFolderConfirm", { path: deletePathTarget })}
              </p>
              <label className="flex items-center gap-2 mb-4 cursor-pointer">
                <input type="checkbox" checked={disbandOnly} onChange={(e) => setDisbandOnly(e.target.checked)}
                  className="rounded w-4 h-4" />
                <span className="text-sm">{t("docs.disbandOnly")}</span>
              </label>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setDeletePathTarget(null)} className="px-4 py-2 border rounded-lg text-sm">{t("kb.cancel")}</button>
                <button onClick={handleDeleteFolderConfirm}
                  className={`px-4 py-2 rounded-lg text-sm text-white ${disbandOnly ? "bg-amber-500 hover:bg-amber-600" : "bg-red-500 hover:bg-red-600"}`}>
                  {disbandOnly ? t("docs.disbandBtn") : t("docs.deleteFolderBtn")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Description reading dialog */}
      {showDescDialog && kb?.description && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowDescDialog(false)}>
          <div className="bg-card border rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b shrink-0">
              <h3 className="font-semibold">{kb.name}</h3>
              <button onClick={() => setShowDescDialog(false)} className="p-1 hover:bg-muted rounded-md">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto flex-1">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{kb.description}</p>
            </div>
          </div>
        </div>
      )}

      {/* Error detail dialog */}
      {errorDetailTarget !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setErrorDetailTarget(null)}>
          <div className="bg-card border rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b shrink-0">
              <h3 className="font-semibold text-red-600">MinerU Parse Error</h3>
              <div className="flex items-center gap-1">
                <button
                  onClick={async () => {
                    if (errorDetailTarget) {
                      await navigator.clipboard.writeText(errorDetailTarget);
                      setErrorCopied(true);
                      setTimeout(() => setErrorCopied(false), 2000);
                    }
                  }}
                  className="p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground text-xs flex items-center gap-1"
                  title={t("app.copyError")}
                >
                  {errorCopied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                </button>
                <button onClick={() => setErrorDetailTarget(null)} className="p-1 hover:bg-muted rounded-md">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto flex-1">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{errorDetailTarget}</p>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
