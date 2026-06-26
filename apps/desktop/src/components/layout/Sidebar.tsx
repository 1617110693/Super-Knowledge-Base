import { useEffect, useState, useMemo } from "react";
import { Link, useLocation, useParams, useNavigate } from "react-router-dom";
import { useKBStore } from "../../stores/useKBStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useChatStore } from "../../stores/useChatStore";
import { useI18n } from "../../i18n";
import { BookOpen, Settings, FolderOpen, AlertCircle, X, Layers, Pin, MessageSquare, Plus, ChevronDown, ChevronRight, LayoutDashboard, Pencil, Check, Trash2 } from "lucide-react";

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { kbId } = useParams();
  const { knowledgeBases, loadKBs, getSortedKBs, sortMode } = useKBStore();
  const { pythonRunning, pythonError } = useSettingsStore();
  const { conversations, activeConversationId, setActiveConversation, newConversation, deleteConversation, renameConversation, load: loadChats } = useChatStore();
  useEffect(() => { loadChats(); }, [loadChats]);
  const { t } = useI18n();
  const [showError, setShowError] = useState(false);
  const [kbExpanded, setKbExpanded] = useState(true);
  const [chatExpanded, setChatExpanded] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => { loadKBs(); }, []);
  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path + "/");
  const sortedKBs = useMemo(() => getSortedKBs(), [knowledgeBases, sortMode]);

  const recentConversations = useMemo(
    () => [...conversations].reverse(),
    [conversations]
  );

  return (
    <>
      <aside className="w-56 bg-card border-r flex flex-col shrink-0">
        {/* App title + status */}
        <div className="p-4 border-b shrink-0">
          <h1 className="text-sm font-semibold flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary" />
            {t("app.title")}
          </h1>
          <div className="flex items-center gap-1 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${pythonRunning ? "bg-green-500" : "bg-red-500"}`} />
            <span className="text-xs text-muted-foreground">
              {pythonRunning ? t("app.backendReady") : t("app.backendOffline")}
            </span>
          </div>
          {pythonError && (
            <button onClick={() => setShowError(true)} className="flex items-center gap-1 mt-1 text-xs text-amber-600 hover:text-amber-700 cursor-pointer">
              <AlertCircle className="w-3 h-3" />
              {t("app.viewError")}
            </button>
          )}
        </div>

        {/* Middle section — CSS Grid, two equal rows */}
        <div className="flex-1 min-h-0 py-2 px-2" style={{ display: "grid", gridTemplateRows: "1fr 1fr", gap: "0.25rem" }}>
          {/* ══════ KB Section ══════ */}
          <div className="flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
            <button onClick={() => setKbExpanded(!kbExpanded)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors hover:bg-muted text-muted-foreground shrink-0">
              {kbExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <FolderOpen className="w-4 h-4" />
              <span className="flex-1 text-left">{t("nav.knowledgeBases")}</span>
            </button>
            {kbExpanded && (
              <div className="ml-2 border-l border-border/50 pl-2 mt-0.5 overflow-y-auto flex-1 min-h-0">
                <Link to="/"
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors ${isActive("/") && !kbId ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-muted-foreground"}`}>
                  <LayoutDashboard className="w-3 h-3 shrink-0" />
                  {t("nav.overview")}
                </Link>
                {sortedKBs.map((kb) => (
                  <Link key={kb.id} to={`/kb/${kb.id}`} title={kb.description || undefined}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors ${kbId === kb.id ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-muted-foreground"}`}>
                    {kb.pinned ? <Pin className="w-2.5 h-2.5 text-amber-500 shrink-0" /> : <Layers className="w-3 h-3 shrink-0" />}
                    <span className="truncate">{kb.name}</span>
                    <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0">{kb.document_count}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* ══════ Chat Section ══════ */}
          <div className="flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
            <button onClick={() => setChatExpanded(!chatExpanded)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors hover:bg-muted text-muted-foreground shrink-0">
              {chatExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <MessageSquare className="w-4 h-4" />
              <span className="flex-1 text-left">{t("nav.chat")}</span>
              <button onClick={(e) => { e.stopPropagation(); setChatExpanded(true); const id = newConversation(); navigate(`/chat/${id}`); }}
                className="p-0.5 hover:bg-background rounded" title={t("chat.new")}>
                <Plus className="w-3 h-3" />
              </button>
            </button>
            {chatExpanded && (
              <div className="ml-2 border-l border-border/50 pl-2 mt-0.5 overflow-y-auto flex-1 min-h-0">
                {recentConversations.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-2 py-1">{t("chat.empty")}</p>
                ) : (
                  recentConversations.map((conv) => (
                    <div key={conv.id} className="group relative">
                      {renamingId === conv.id ? (
                        <div className="flex items-center gap-1 px-2 py-1.5">
                          <input autoFocus value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { renameConversation(conv.id, renameDraft); setRenamingId(null); }
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            onBlur={() => { renameConversation(conv.id, renameDraft); setRenamingId(null); }}
                            className="text-xs bg-background border rounded px-1.5 py-0.5 flex-1 outline-none ring-1 ring-primary" />
                        </div>
                      ) : (
                        <Link to={`/chat/${conv.id}`} onClick={() => setActiveConversation(conv.id)}
                          className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors truncate ${activeConversationId === conv.id && location.pathname.startsWith("/chat") ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-muted-foreground"}`}>
                          <MessageSquare className="w-3 h-3 shrink-0" />
                          <span className="truncate text-xs flex-1">{conv.title || conv.messages[0]?.content?.slice(0, 30) || t("chat.new")}</span>
                        </Link>
                      )}
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5">
                        <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRenamingId(conv.id); setRenameDraft(conv.title || ""); }}
                          className="p-0.5 hover:bg-muted rounded text-muted-foreground/60" title={t("kb.rename")}>
                          <Pencil className="w-2.5 h-2.5" />
                        </button>
                        <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteConversation(conv.id); }}
                          className="p-0.5 hover:bg-red-50 rounded text-muted-foreground/60 hover:text-red-500" title={t("docs.delete")}>
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* Settings — fixed to bottom */}
        <div className="p-2 border-t shrink-0">
          <Link to="/settings"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${isActive("/settings") ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-muted-foreground"}`}>
            <Settings className="w-4 h-4" />
            {t("nav.settings")}
          </Link>
        </div>
      </aside>

      {/* Error Dialog */}
      {showError && pythonError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowError(false)}>
          <div className="bg-card border rounded-xl shadow-xl max-w-lg w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-red-500" />
                {t("app.backendError")}
              </h3>
              <button onClick={() => setShowError(false)} className="hover:bg-muted rounded-md p-1"><X className="w-4 h-4" /></button>
            </div>
            <pre className="text-xs bg-muted p-4 rounded-lg overflow-auto max-h-80 whitespace-pre-wrap break-all">{pythonError}</pre>
          </div>
        </div>
      )}
    </>
  );
}
