import { useRef, useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, X, ChevronLeft, ChevronRight } from "lucide-react";
import { useTabStore, type TabEntry } from "../../stores/useTabStore";

// ── Helpers ────────────────────────────────────────────────────────

interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

// ── TabItem ────────────────────────────────────────────────────────

function TabItem({
  tab,
  isActive,
  onSelect,
  onClose,
  onContextMenu,
}: {
  tab: TabEntry;
  isActive: boolean;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", tab.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData("text/plain");
    if (!fromId || fromId === tab.id) return;
    const store = useTabStore.getState();
    const fromIdx = store.tabs.findIndex((t) => t.id === fromId);
    const toIdx = store.tabs.findIndex((t) => t.id === tab.id);
    if (fromIdx !== -1 && toIdx !== -1) {
      store.reorderTabs(fromIdx, toIdx);
    }
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          useTabStore.getState().closeTab(tab.id);
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`
        group relative flex items-center gap-1.5 shrink-0 h-full pl-2.5 pr-1.5 cursor-pointer select-none
        text-[12px] transition-all duration-100
        ${isActive
          ? "bg-background text-foreground font-medium rounded-t-md border-x border-t border-border"
          : "text-muted-foreground hover:bg-muted/60 mr-0"
        }
      `}
      style={{ maxWidth: 180 }}
    >
      {/* Bottom connector — active tab blends into content area */}
      {isActive && (
        <div className="absolute -bottom-px left-0 right-0 h-px bg-background z-10" />
      )}

      {/* Unsaved dot */}
      {tab.isDirty && (
        <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" title="Unsaved changes" />
      )}

      {/* Icon */}
      <FileText className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground/60"}`} />

      {/* Title */}
      <span className="truncate">{tab.docName}</span>

      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(e);
        }}
        className={`
          shrink-0 ml-0.5 p-0.5 rounded-sm transition-all
          ${hover || isActive
            ? "opacity-100 hover:bg-muted-foreground/15"
            : "opacity-0"
          }
        `}
        title="Close"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// ── TabBar ──────────────────────────────────────────────────────────

export function TabBar() {
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const closeTab = useTabStore((s) => s.closeTab);
  const closeOtherTabs = useTabStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useTabStore((s) => s.closeTabsToRight);
  const closeAllTabs = useTabStore((s) => s.closeAllTabs);
  const reopenLastClosed = useTabStore((s) => s.reopenLastClosed);
  const setActiveTab = useTabStore((s) => s.setActiveTab);

  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  // ── Overflow detection ──────────────────────────────────────────
  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeftArrow(el.scrollLeft > 1);
    setShowRightArrow(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    checkOverflow();
    const el = scrollRef.current;
    if (el) {
      el.addEventListener("scroll", checkOverflow, { passive: true });
      const ro = new ResizeObserver(checkOverflow);
      ro.observe(el);
      return () => {
        el.removeEventListener("scroll", checkOverflow);
        ro.disconnect();
      };
    }
  }, [checkOverflow, tabs.length]);

  // ── Auto-scroll to active tab ────────────────────────────────────
  useEffect(() => {
    if (!activeTabId || !scrollRef.current) return;
    const el = scrollRef.current;
    const tabEl = el.querySelector(`[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
    if (tabEl) {
      tabEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
  }, [activeTabId]);

  // ── Scroll buttons ───────────────────────────────────────────────
  const scrollBy = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * 180, behavior: "smooth" });
  };

  // ── Context menu close ───────────────────────────────────────────
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu]);

  // ── Empty state ──────────────────────────────────────────────────
  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar flex items-end h-8 shrink-0 bg-muted/50 border-b border-border select-none">
      {/* Left overflow arrow */}
      {showLeftArrow && (
        <button
          onClick={() => scrollBy(-1)}
          className="shrink-0 h-7 px-0.5 hover:bg-muted/60 transition-colors text-muted-foreground"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Tab strip — items align to bottom (end) */}
      <div
        ref={scrollRef}
        className="flex items-end h-full flex-1 overflow-hidden"
        onWheel={(e) => {
          if (e.deltaY !== 0) {
            e.preventDefault();
            scrollRef.current?.scrollBy({ left: e.deltaY * 2, behavior: "auto" });
          }
        }}
      >
        {/* Spacer before tabs */}
        <div className="w-1 shrink-0" />

        {tabs.map((tab) => (
          <div key={tab.id} data-tab-id={tab.id} className="h-full flex items-end">
            <TabItem
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={() => {
                setActiveTab(tab.id);
                if (tab.type === "chat") {
                  navigate(`/chat/${tab.convId}`);
                } else {
                  navigate(`/kb/${tab.kbId}/documents/${tab.docId}`);
                }
              }}
              onClose={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
            />
          </div>
        ))}

        {/* Fill remaining space so active tab border extends naturally */}
        <div className="flex-1 border-b border-border" />
      </div>

      {/* Right overflow arrow */}
      {showRightArrow && (
        <button
          onClick={() => scrollBy(1)}
          className="shrink-0 h-7 px-0.5 hover:bg-muted/60 transition-colors text-muted-foreground"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      )}

      {/* ── Context Menu ── */}
      {ctxMenu && (
        <div
          className="fixed z-[100] min-w-[180px] py-1 bg-popover border border-border rounded-lg shadow-lg text-xs"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <ContextMenuItem
            label="Close"
            onClick={() => { closeTab(ctxMenu.tabId); setCtxMenu(null); }}
          />
          <ContextMenuItem
            label="Close Others"
            onClick={() => { closeOtherTabs(ctxMenu.tabId); setCtxMenu(null); }}
          />
          <ContextMenuItem
            label="Close to the Right"
            onClick={() => { closeTabsToRight(ctxMenu.tabId); setCtxMenu(null); }}
          />
          <ContextMenuItem
            label="Close All"
            onClick={() => { closeAllTabs(); setCtxMenu(null); }}
          />
          <div className="h-px bg-border my-1" />
          <ContextMenuItem
            label="Reopen Closed Tab"
            disabled={useTabStore.getState().closedTabs.length === 0}
            onClick={() => { reopenLastClosed(); setCtxMenu(null); }}
          />
          <div className="h-px bg-border my-1" />
          <ContextMenuItem
            label="Copy Document Path"
            onClick={async () => {
              setCtxMenu(null);
              const tab = useTabStore.getState().tabs.find((t) => t.id === ctxMenu.tabId);
              if (tab) {
                try { await navigator.clipboard.writeText(`${tab.kbId}/${tab.docId}`); } catch {}
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── ContextMenuItem ──────────────────────────────────────────────────

function ContextMenuItem({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 transition-colors ${
        disabled
          ? "text-muted-foreground/40 cursor-default"
          : "hover:bg-accent hover:text-accent-foreground"
      }`}
    >
      {label}
    </button>
  );
}
