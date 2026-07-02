import { useState, useMemo, useCallback } from "react";
import { useI18n } from "../../i18n";
import { FolderOpen, FolderSearch, X, ChevronRight, ChevronDown, Copy, GripHorizontal, Check, Loader2, Database, Plus, Trash2, Pencil } from "lucide-react";
import type { Document, KnowledgeBase } from "../../types";

interface Props {
  open: boolean;
  onClose: () => void;
  doc?: Document;
  folderPath?: string;
  kbId: string;
  allKbs: KnowledgeBase[];
  paths: string[];
  onComplete: () => void;
}

type OpMode = "move" | "copy";

export function MoveCopyDialog({ open, onClose, doc, folderPath, kbId, allKbs, paths, onComplete }: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<OpMode>("move");
  const [targetKbId, setTargetKbId] = useState<string>(kbId);
  const [targetPath, setTargetPath] = useState<string | null>(folderPath ?? null);
  const [executing, setExecuting] = useState(false);
  const [done, setDone] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [localPaths, setLocalPaths] = useState<string[]>(paths);
  // Inline new-folder state: the parent under which a new folder is being created
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const [newFolderDraft, setNewFolderDraft] = useState("");
  // Rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Delete confirmation
  const [deleteConfirmPath, setDeleteConfirmPath] = useState<string | null>(null);

  useMemo(() => { setLocalPaths(paths); }, [paths]);

  const currentKb = allKbs.find(k => k.id === kbId);
  const compatibleKbs = useMemo(() => {
    if (!currentKb?.embedding_model) return allKbs.filter(k => k.id === kbId);
    return allKbs.filter(k =>
      k.id === kbId || k.embedding_model === currentKb.embedding_model
    );
  }, [allKbs, currentKb]);

  const targetKb = allKbs.find(k => k.id === targetKbId);
  const isSameKb = targetKbId === kbId;

  const handleExecute = async () => {
    if (executing || !doc) return;
    setExecuting(true);
    try {
      if (mode === "move") {
        if (isSameKb) {
          const { setDocumentPath } = await import("../../services/tauriBridge");
          await setDocumentPath(kbId, doc.id, targetPath);
        } else {
          const { copyDocumentToKb, deleteDocument } = await import("../../services/tauriBridge");
          await copyDocumentToKb(kbId, doc.id, targetKbId, targetPath);
          await deleteDocument(kbId, doc.id);
        }
      } else {
        const { copyDocumentToKb } = await import("../../services/tauriBridge");
        await copyDocumentToKb(kbId, doc.id, targetKbId, targetPath);
      }
      setDone(true);
      setTimeout(() => { onComplete(); onClose(); setDone(false); }, 800);
    } catch (e) {
      console.error("Operation failed:", e);
    } finally {
      setExecuting(false);
    }
  };

  const persistCreateFolder = useCallback(async (parent: string | null, name: string) => {
    if (!targetKbId || !name.trim()) return;
    const fullPath = parent ? `${parent}/${name.trim()}` : name.trim();
    try {
      const { createFolder } = await import("../../services/tauriBridge");
      await createFolder(targetKbId, fullPath);
      setLocalPaths(prev => {
        const updated = [...prev, fullPath];
        const parts = fullPath.split("/");
        for (let i = 1; i < parts.length; i++) {
          const p = parts.slice(0, i).join("/");
          if (!updated.includes(p)) updated.push(p);
        }
        updated.sort();
        return updated;
      });
      if (parent) setExpandedPaths(prev => new Set([...prev, parent]));
    } catch (e) { console.error("Create folder failed:", e); }
  }, [targetKbId]);

  const handleDeleteFolder = useCallback(async (path: string) => {
    if (!targetKbId) return;
    try {
      const { removeFolder } = await import("../../services/tauriBridge");
      await removeFolder(targetKbId, path);
      setLocalPaths(prev => prev.filter(p => p !== path && !p.startsWith(path + "/")));
      if (targetPath === path || targetPath?.startsWith(path + "/")) setTargetPath(null);
    } catch (e) { console.error("Delete folder failed:", e); }
  }, [targetKbId, targetPath]);

  const handleRenameFolder = useCallback(async () => {
    if (!renamingPath || !renameDraft.trim() || !targetKbId) return;
    const oldPath = renamingPath;
    const oldName = oldPath.includes("/") ? oldPath.split("/").pop()! : oldPath;
    const newName = renameDraft.trim();
    if (newName === oldName) { setRenamingPath(null); return; }
    const parent = oldPath.includes("/") ? oldPath.split("/").slice(0, -1).join("/") : "";
    const newPath = parent ? `${parent}/${newName}` : newName;
    try {
      const { renamePath } = await import("../../services/tauriBridge");
      await renamePath(targetKbId, oldPath, newPath);
      setLocalPaths(prev => prev.map(p => {
        if (p === oldPath) return newPath;
        if (p.startsWith(oldPath + "/")) return newPath + p.slice(oldPath.length);
        return p;
      }));
      if (targetPath === oldPath) setTargetPath(newPath);
      else if (targetPath?.startsWith(oldPath + "/")) setTargetPath(newPath + targetPath.slice(oldPath.length));
    } catch (e) { console.error("Rename folder failed:", e); }
    setRenamingPath(null);
  }, [renamingPath, renameDraft, targetKbId, targetPath]);

  type TreeNode = { children: Record<string, TreeNode> };
  const folderTree = useMemo(() => {
    // When operating on a folder, exclude it and all its descendants from the tree
    const visible = folderPath
      ? localPaths.filter(p => p !== folderPath && !p.startsWith(folderPath + "/"))
      : localPaths;
    const root: Record<string, TreeNode> = {};
    for (const p of [...visible].sort()) {
      const parts = p.split("/");
      let node = root;
      for (const part of parts) {
        if (!node[part]) node[part] = { children: {} };
        node = node[part].children;
      }
    }
    return root;
  }, [localPaths, folderPath]);

  if (!open) return null;

  const toggleExpand = (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  // Path for display: "根目录" or "根目录/A/B"
  const displayPath = targetPath
    ? `${t("docs.root")}/${targetPath}`
    : t("docs.root") as string;

  const renderTree = (tree: Record<string, TreeNode>, prefix: string = "", depth: number = 0): React.ReactNode[] => {
    return Object.keys(tree).sort().map(name => {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      const hasChildren = Object.keys(tree[name].children).length > 0;
      const isExpanded = expandedPaths.has(fullPath);
      const isSelected = targetPath === fullPath;
      const isRenaming = renamingPath === fullPath;

      // Is a new folder being created as a child of this node?
      const creatingHere = creatingUnder === fullPath;

      const nodes: React.ReactNode[] = [];
      nodes.push(
        <div key={fullPath} className="group flex items-center hover:bg-muted/30 rounded">
          {/* Chevron: click to expand/collapse */}
          <button
            onClick={(e) => { e.stopPropagation(); if (hasChildren) toggleExpand(fullPath); }}
            className="p-0.5 shrink-0 text-muted-foreground hover:text-foreground"
            style={{ marginLeft: `${depth * 16}px` }}
          >
            {hasChildren ? (
              isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
            ) : (
              <span className="w-3.5 h-3.5 inline-block" />
            )}
          </button>

          {isRenaming ? (
            <div className="flex items-center gap-1 flex-1 min-w-0 px-1">
              <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleRenameFolder(); if (e.key === "Escape") setRenamingPath(null); }}
                className="flex-1 px-1 py-0 text-xs border rounded bg-background min-w-0"
              />
              <button onClick={handleRenameFolder} disabled={!renameDraft.trim()} className="p-0.5 hover:bg-muted rounded text-primary"><Check className="w-3 h-3" /></button>
              <button onClick={() => setRenamingPath(null)} className="p-0.5 hover:bg-muted rounded"><X className="w-3 h-3" /></button>
            </div>
          ) : (
            <button
              onClick={() => { if (hasChildren) toggleExpand(fullPath); setTargetPath(isSelected ? null : fullPath); }}
              className={`flex-1 flex items-center gap-1.5 px-1 py-1 text-xs rounded transition-colors ${isSelected ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground"}`}
            >
              <FolderOpen className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-primary" : "text-amber-500"}`} />
              <span className="truncate">{name}</span>
              {isSelected && <Check className="w-3 h-3 ml-auto shrink-0" />}
            </button>
          )}

          {/* Actions (same KB, on hover, not renaming) */}
          {isSameKb && !isRenaming && (
            <div className="flex items-center opacity-0 group-hover:opacity-100 transition-all mr-1">
              <button
                onClick={(e) => { e.stopPropagation(); setCreatingUnder(fullPath); setNewFolderDraft(""); }}
                className="p-0.5 hover:bg-muted rounded text-muted-foreground" title={t("docs.newFolderSub") as string}
              >
                <Plus className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setRenamingPath(fullPath); setRenameDraft(name); }}
                className="p-0.5 hover:bg-muted rounded text-muted-foreground" title={t("docs.rename") as string}
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteConfirmPath(fullPath); }}
                className="p-0.5 hover:bg-red-50 rounded text-muted-foreground hover:text-red-500" title={t("docs.delete") as string}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      );

      // Render the inline new-folder input right under this node
      if (creatingHere) {
        nodes.push(
          <div key={`${fullPath}-new-child`} className="flex items-center gap-1 px-1 py-0.5 rounded" style={{ paddingLeft: `${32 + depth * 16}px` }}>
            <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0 opacity-40" />
            <input
              autoFocus
              value={newFolderDraft}
              onChange={(e) => setNewFolderDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { persistCreateFolder(fullPath, newFolderDraft); setCreatingUnder(undefined); setNewFolderDraft(""); }
                if (e.key === "Escape") { setCreatingUnder(undefined); setNewFolderDraft(""); }
              }}
              onBlur={() => {
                if (newFolderDraft.trim()) { persistCreateFolder(fullPath, newFolderDraft); }
                setCreatingUnder(undefined); setNewFolderDraft("");
              }}
              placeholder={t("docs.folderName") as string}
              className="flex-1 px-2 py-0.5 text-xs border rounded bg-background min-w-0"
            />
          </div>
        );
      }

      // Children
      if (hasChildren && isExpanded) {
        nodes.push(...renderTree(tree[name].children, fullPath, depth + 1));
      }

      // If this is the root node (no prefix) and creating at root level, show inline input AFTER root's children
      // handled at the root level via creatingUnder === null
      return nodes;
    }).flat();
  };

  const itemLabel = doc ? doc.name : (folderPath || t("docs.root") as string);
  const canExecute = !executing && !done;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl shadow-xl w-[560px] max-h-[75vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b shrink-0">
          <div>
            <h3 className="font-semibold text-sm">{t("docs.operationsDialogTitle")}</h3>
            <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[440px]">
              {doc ? <><FileIcon /> {itemLabel}</> : <><FolderOpen className="w-3.5 h-3.5 inline text-amber-500" /> {itemLabel}</>}
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded-md"><X className="w-4 h-4" /></button>
        </div>

        {doc && (
          <div className="flex border-b shrink-0">
            <button
              onClick={() => { setMode("move"); if (!isSameKb) setTargetKbId(kbId); }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors ${mode === "move" ? "text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              <GripHorizontal className="w-3.5 h-3.5" />
              {t("docs.move")}
            </button>
            <button
              onClick={() => setMode("copy")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors ${mode === "copy" ? "text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Copy className="w-3.5 h-3.5" />
              {t("docs.copy")}
            </button>
          </div>
        )}

        {compatibleKbs.length > 1 && (
          <div className="px-4 pt-3 shrink-0">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">{t("docs.targetKb")}</label>
            <div className="flex flex-wrap gap-1 mt-1">
              {compatibleKbs.map(kb => (
                <button
                  key={kb.id}
                  onClick={() => { setTargetKbId(kb.id); setTargetPath(null); }}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors ${targetKbId === kb.id ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/70"}`}
                >
                  <Database className="w-3 h-3" />
                  {kb.name}
                  {kb.id === kbId && <span className="text-[10px] opacity-70">({t("docs.current")})</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="px-4 py-3 shrink-0">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">{doc ? t("docs.destination") : t("docs.manageFolder")}</label>
          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1 bg-muted/50 rounded-md px-2 py-1">
            <FolderSearch className="w-3 h-3 shrink-0" />
            {targetKb && <span className="font-medium text-foreground">{targetKb.name}</span>}
            <ChevronRight className="w-3 h-3" />
            <span>{displayPath}</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1 border-t">
          {/* Root option */}
          <div className="group flex items-center hover:bg-muted/30 rounded">
            <span className="w-3.5 h-3.5 inline-block" />
            <button
              onClick={() => setTargetPath(null)}
              className={`flex-1 flex items-center gap-1.5 px-1 py-1 text-xs rounded transition-colors ${targetPath === null ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground"}`}
            >
              <FolderOpen className={`w-3.5 h-3.5 shrink-0 ${targetPath === null ? "text-primary" : "text-muted-foreground"}`} />
              <span>{t("docs.root")}</span>
              {targetPath === null && <Check className="w-3 h-3 ml-auto shrink-0" />}
            </button>
            {isSameKb && (
              <div className="flex items-center opacity-0 group-hover:opacity-100 transition-all mr-1">
                <button
                  onClick={() => { setCreatingUnder(null); setNewFolderDraft(""); }}
                  className="p-0.5 hover:bg-muted rounded text-muted-foreground" title={t("docs.newFolderSub") as string}
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {/* Inline new-folder under root */}
          {creatingUnder === null && (
            <div className="flex items-center gap-1 px-1 py-0.5 rounded" style={{ paddingLeft: '20px' }}>
              <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0 opacity-40" />
              <input
                autoFocus
                value={newFolderDraft}
                onChange={(e) => setNewFolderDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { persistCreateFolder(null, newFolderDraft); setCreatingUnder(undefined); setNewFolderDraft(""); }
                  if (e.key === "Escape") { setCreatingUnder(undefined); setNewFolderDraft(""); }
                }}
                onBlur={() => {
                  if (newFolderDraft.trim()) { persistCreateFolder(null, newFolderDraft); }
                  setCreatingUnder(undefined); setNewFolderDraft("");
                }}
                placeholder={t("docs.folderName") as string}
                className="flex-1 px-2 py-0.5 text-xs border rounded bg-background min-w-0"
              />
            </div>
          )}

          {renderTree(folderTree)}
          {Object.keys(folderTree).length === 0 && creatingUnder === undefined && (
            <p className="text-xs text-muted-foreground text-center py-4">{t("docs.noFolders")}</p>
          )}
        </div>

        <div className="flex items-center justify-between p-3 border-t shrink-0">
          <p className="text-[10px] text-muted-foreground">
            {doc && mode === "move" && !isSameKb ? t("docs.moveCrossKbHint")
              : doc && mode === "copy" ? t("docs.copyHint")
              : doc ? t("docs.moveHint")
              : t("docs.folderManageHint")}
          </p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1 text-xs border rounded-md hover:bg-muted">
              {t("docs.cancel") || "Cancel"}
            </button>
            {doc && (
              <button
                onClick={handleExecute}
                disabled={!canExecute}
                className="flex items-center gap-1 px-3 py-1 text-xs bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
              >
                {done ? <Check className="w-3.5 h-3.5" /> : executing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : mode === "move" ? <GripHorizontal className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {done ? t("docs.done") || "Done" : mode === "move" ? t("docs.move") : t("docs.copy")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Delete folder confirmation overlay */}
      {deleteConfirmPath && (
        <div className="absolute inset-0 bg-black/30 flex items-center justify-center rounded-xl" onClick={() => setDeleteConfirmPath(null)}>
          <div className="bg-card border rounded-lg shadow-xl p-4 mx-6 max-w-xs" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium mb-1">{t("docs.deleteFolder")}</p>
            <p className="text-xs text-muted-foreground mb-3">
              {t("docs.deleteFolderConfirm", { path: deleteConfirmPath })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setDeleteConfirmPath(null)} className="px-2 py-1 text-xs border rounded-md hover:bg-muted">
                {t("docs.cancel") || "Cancel"}
              </button>
              <button
                onClick={() => { handleDeleteFolder(deleteConfirmPath); setDeleteConfirmPath(null); }}
                className="px-2 py-1 text-xs bg-red-600 text-white rounded-md hover:bg-red-700"
              >
                {t("docs.deleteFolderBtn") || "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FileIcon() {
  return (
    <svg className="w-3.5 h-3.5 inline text-primary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
