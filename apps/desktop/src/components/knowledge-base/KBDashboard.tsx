import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useKBStore, type SortMode } from "../../stores/useKBStore";
import { useI18n } from "../../i18n";
import { Plus, Trash2, FolderOpen, BookOpen, FileText, Layers, Pin, PinOff, Grid3X3, AlignJustify, LayoutGrid, RefreshCw, Search } from "lucide-react";
import { ConfirmDialog } from "../common/ConfirmDialog";
import type { KnowledgeBase } from "../../types";
import { GlobalSearchDialog } from "../search/GlobalSearchDialog";

function useSortOptions() {
  const { t } = useI18n();
  return [
    { value: "manual" as SortMode, label: t("kb.sortDefault") },
    { value: "name-asc" as SortMode, label: t("kb.sortNameAsc") },
    { value: "name-desc" as SortMode, label: t("kb.sortNameDesc") },
    { value: "date-asc" as SortMode, label: t("kb.sortDateAsc") },
    { value: "date-desc" as SortMode, label: t("kb.sortDateDesc") },
  ];
}

export function KBDashboard() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { knowledgeBases, loadKBs, createKB, deleteKB, togglePinKB, viewMode, sortMode, setViewMode, setSortMode, getSortedKBs } = useKBStore();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);

  useEffect(() => { loadKBs(); }, []);

  const sortedKBs = useMemo(() => getSortedKBs(), [knowledgeBases, sortMode]);
  const sortOptions = useSortOptions();

  const handleCreate = async () => {
    if (!name.trim()) return;
    await createKB(name, description);
    setName(""); setDescription(""); setShowCreate(false);
  };

  const handleDelete = (kbId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget(kbId);
  };

  const handleDeleteConfirm = async () => {
    if (deleteTarget) {
      await deleteKB(deleteTarget);
      setDeleteTarget(null);
    }
  };

  const handleRefresh = async () => { await loadKBs(); };

  const handlePin = async (kbId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await togglePinKB(kbId);
  };

  const renderCompactItem = (kb: KnowledgeBase) => (
    <div key={kb.id} onClick={() => navigate(`/kb/${kb.id}`)}
      className="flex items-center justify-between px-3 py-1.5 border rounded-md bg-card hover:border-primary/50 cursor-pointer transition-colors">
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {kb.pinned && <Pin className="w-3 h-3 text-amber-500 shrink-0" />}
        {!kb.pinned && <FolderOpen className="w-3.5 h-3.5 text-primary/70 shrink-0" />}
        <span className="font-medium text-sm truncate">{kb.name}</span>
        {kb.description && (
          <span className="text-xs text-muted-foreground truncate max-w-[12rem] hidden sm:inline shrink-[2]">{kb.description}</span>
        )}
      </div>
      <div className="flex items-center gap-1.5 ml-2 shrink-0">
        <span className="text-[10px] text-muted-foreground/60">{kb.document_count}</span>
        <button onClick={(e) => handlePin(kb.id, e)} className="p-0.5 hover:bg-muted rounded text-muted-foreground" title={kb.pinned ? t("kb.unpin") : t("kb.pin")}>
          {kb.pinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
        </button>
        <button onClick={(e) => handleDelete(kb.id, e)} className="p-0.5 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500 transition-colors" title={t("docs.delete")}>
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );

  const renderCardItem = (kb: KnowledgeBase) => (
    <div key={kb.id} onClick={() => navigate(`/kb/${kb.id}`)}
      className="flex items-center justify-between p-4 border rounded-lg bg-card hover:border-primary/50 cursor-pointer transition-colors">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="relative shrink-0">
          <FolderOpen className="w-8 h-8 text-primary" />
          {kb.pinned && <Pin className="w-3 h-3 text-amber-500 absolute -top-1 -right-1" />}
        </div>
        <div className="min-w-0 min-h-[3.5rem] flex flex-col justify-center flex-1">
          <h3 className="font-semibold truncate">{kb.name}</h3>
          <p className="text-sm text-muted-foreground line-clamp-1 break-words min-h-[1.25rem]">
            {kb.description || " "}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><FileText className="w-3 h-3" />{kb.document_count} {t("kb.docs")}</span>
            {kb.chunk_count > 0 && (
              <span className="flex items-center gap-1"><Layers className="w-3 h-3" />{kb.chunk_count} {t("kb.chunks")}</span>
            )}
            {kb.embedding_model && (
              <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium">{kb.embedding_model}</span>
            )}
            {kb.embedding_dim > 0 && <span>dim {kb.embedding_dim}</span>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 ml-3 shrink-0">
        <button onClick={(e) => handlePin(kb.id, e)} className="p-1.5 hover:bg-muted rounded-md text-muted-foreground" title={kb.pinned ? t("kb.unpin") : t("kb.pin")}>
          {kb.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
        </button>
        <button onClick={(e) => handleDelete(kb.id, e)} className="p-1.5 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500 transition-colors" title={t("docs.delete")}>
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  const renderGridItem = (kb: KnowledgeBase) => (
    <div key={kb.id} onClick={() => navigate(`/kb/${kb.id}`)}
      className="flex flex-col items-center justify-between p-4 border rounded-lg bg-card hover:border-primary/50 cursor-pointer transition-colors aspect-square">
      <div className="flex flex-col items-center gap-2 min-w-0 w-full flex-1 justify-center">
        <div className="relative">
          <FolderOpen className="w-10 h-10 text-primary" />
          {kb.pinned && <Pin className="w-3.5 h-3.5 text-amber-500 absolute -top-1 -right-1" />}
        </div>
        <h3 className="font-semibold text-sm text-center truncate w-full">{kb.name}</h3>
        <p className="text-xs text-muted-foreground text-center line-clamp-1 break-words w-full h-5 overflow-hidden">
          {kb.description || " "}
        </p>
      </div>
      <div className="flex items-center justify-between w-full mt-2 pt-2 border-t">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-0.5"><FileText className="w-3 h-3" />{kb.document_count}</span>
          {kb.chunk_count > 0 && <span className="flex items-center gap-0.5"><Layers className="w-3 h-3" />{kb.chunk_count}</span>}
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={(e) => handlePin(kb.id, e)} className="p-1 hover:bg-muted rounded text-muted-foreground" title={kb.pinned ? t("kb.unpin") : t("kb.pin")}>
            {kb.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
          </button>
          <button onClick={(e) => handleDelete(kb.id, e)} className="p-1 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500 transition-colors" title={t("docs.delete")}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">{t("kb.dashboard")}</h2>
          <p className="text-muted-foreground text-sm mt-1">{t("kb.desc")}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleRefresh} className="p-2 border rounded-lg text-muted-foreground hover:bg-muted transition-colors" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90">
            <Plus className="w-4 h-4" />{t("kb.new")}
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="mb-6 p-4 border rounded-lg bg-card">
          <h3 className="font-semibold mb-3">{t("kb.create")}</h3>
          <input type="text" placeholder={t("kb.name")} value={name} onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border rounded-md mb-2 text-sm bg-background" onKeyDown={(e) => e.key === "Enter" && handleCreate()} />
          <input type="text" placeholder={t("kb.description")} value={description} onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 border rounded-md mb-3 text-sm bg-background" />
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-1.5 bg-primary text-primary-foreground rounded-md text-sm">{t("kb.createBtn")}</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-1.5 border rounded-md text-sm">{t("kb.cancel")}</button>
          </div>
        </div>
      )}

      {knowledgeBases.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="flex items-center border rounded-md overflow-hidden">
            <button onClick={() => setViewMode("card")}
              className={`p-1.5 transition-colors ${viewMode === "card" ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"}`}
              title={t("kb.viewCard")}>
              <Grid3X3 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setViewMode("grid")}
              className={`p-1.5 transition-colors ${viewMode === "grid" ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"}`}
              title={t("kb.viewGrid")}>
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setViewMode("compact")}
              className={`p-1.5 transition-colors ${viewMode === "compact" ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"}`}
              title={t("kb.viewCompact")}>
              <AlignJustify className="w-3.5 h-3.5" />
            </button>
          </div>
          <select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="text-xs border rounded-md px-2 py-1.5 bg-card text-muted-foreground cursor-pointer">
            {sortOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground ml-auto">
            {t("nav.knowledgeBaseCount").replace("{count}", String(sortedKBs.length))}
          </span>
          <button
            onClick={() => setGlobalSearchOpen(true)}
            className="p-1.5 border rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title={t("search.searchAllTitle")}
          >
            <Search className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {sortedKBs.length === 0 ? (
        <div className="text-center py-16">
          <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground text-lg">
            {t("kb.empty")}
          </p>
          <p className="text-muted-foreground text-sm mt-1">{t("kb.emptyHint")}</p>
        </div>
      ) : viewMode === "compact" ? (
        <div className="flex flex-col gap-0.5">
          {sortedKBs.map(kb => renderCompactItem(kb))}
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {sortedKBs.map(kb => renderGridItem(kb))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {sortedKBs.map(kb => renderCardItem(kb))}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("kb.deleteConfirm")}
        message={t("kb.deleteConfirm")}
        confirmLabel={t("docs.delete")}
        cancelLabel={t("kb.cancel")}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

      <GlobalSearchDialog open={globalSearchOpen} onClose={() => setGlobalSearchOpen(false)} />
    </div>
  );
}
