import { useEffect, useRef } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTabStore } from "../../stores/useTabStore";
import { useChatStore } from "../../stores/useChatStore";
import { PanelTop } from "lucide-react";

export function AppLayout() {
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const checkPythonStatus = useSettingsStore((s) => s.checkPythonStatus);
  const startPython = useSettingsStore((s) => s.startPython);

  const tabBarVisible = useTabStore((s) => s.tabBarVisible);
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const openTab = useTabStore((s) => s.openTab);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const toggleTabBar = useTabStore((s) => s.toggleTabBar);
  const nextTab = useTabStore((s) => s.nextTab);
  const previousTab = useTabStore((s) => s.previousTab);
  const switchToTabIndex = useTabStore((s) => s.switchToTabIndex);
  const reopenLastClosed = useTabStore((s) => s.reopenLastClosed);

  const location = useLocation();
  const navigate = useNavigate();

  // Guard to prevent navigation loops between URL ↔ tab sync
  const navigatingByTabRef = useRef(false);

  useEffect(() => {
    loadSettings();
    checkPythonStatus().then((running) => {
      if (!running) {
        startPython();
      }
    });
  }, []);

  // ── URL → Tab sync ──────────────────────────────────────────────
  // When navigating to a document or chat route, ensure a tab exists and is active.
  useEffect(() => {
    if (navigatingByTabRef.current) {
      navigatingByTabRef.current = false;
      return;
    }

    // Match document route: /kb/:kbId/documents/:docId
    const docMatch = location.pathname.match(/^\/kb\/([^/]+)\/documents\/([^/]+)/);
    if (docMatch) {
      const [, kbId, docId] = docMatch;
      const existing = tabs.find((t) => t.type === "doc" && t.kbId === kbId && t.docId === docId);
      if (existing) {
        if (activeTabId !== existing.id) setActiveTab(existing.id);
      } else {
        openTab(kbId, docId, docId);
      }
      return;
    }

    // Match chat route: /chat/:convId
    const chatMatch = location.pathname.match(/^\/chat\/([^/]+)/);
    if (chatMatch) {
      const [, convId] = chatMatch;
      const existing = tabs.find((t) => t.type === "chat" && t.convId === convId);
      if (existing) {
        if (activeTabId !== existing.id) setActiveTab(existing.id);
      } else {
        // Look up conversation title from chat store
        const chatStore = useChatStore.getState();
        const conv = chatStore.conversations.find((c) => c.id === convId);
        const title = conv?.title || `Chat ${convId.slice(0, 8)}`;
        useTabStore.getState().openChatTab(convId, title);
      }
      return;
    }

    // Navigated away from tab-supported route
    if (activeTabId && !location.pathname.startsWith("/kb/") && !location.pathname.startsWith("/chat/")) {
      useTabStore.setState({ activeTabId: null });
    }
  }, [location.pathname]);

  // ── Tab Activation → URL navigation ─────────────────────────────
  useEffect(() => {
    if (!activeTabId) {
      // Last tab was closed — go to dashboard if we're on a doc or chat page
      if (location.pathname.startsWith("/kb/") || location.pathname.startsWith("/chat/")) {
        navigate("/", { replace: true });
      }
      return;
    }
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    const targetPath = tab.type === "chat"
      ? `/chat/${tab.convId}`
      : `/kb/${tab.kbId}/documents/${tab.docId}`;
    if (location.pathname !== targetPath) {
      // Don't fight against external navigations: if the current URL already
      // matches some tab's route, URL→Tab sync will handle the activation.
      const matchesSomeTab = tabs.some((t) => {
        const tp = t.type === "chat" ? `/chat/${t.convId}` : `/kb/${t.kbId}/documents/${t.docId}`;
        return tp === location.pathname;
      });
      if (!matchesSomeTab) {
        navigatingByTabRef.current = true;
        navigate(targetPath, { replace: true });
      }
    }
  }, [activeTabId, tabs]);

  // ── Keyboard shortcuts ───────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { ctrlKey, metaKey, shiftKey, key } = e;
      const mod = ctrlKey || metaKey;

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs
      if (mod && key === "Tab") {
        e.preventDefault();
        shiftKey ? previousTab() : nextTab();
        return;
      }

      // Ctrl+W — close active tab
      if (mod && key === "w") {
        const currentActive = useTabStore.getState().activeTabId;
        if (currentActive) {
          e.preventDefault();
          closeTab(currentActive);
        }
        return;
      }

      // Ctrl+Shift+B — toggle tab bar visibility
      if (mod && shiftKey && key === "B") {
        e.preventDefault();
        toggleTabBar();
        return;
      }

      // Ctrl+Shift+T — reopen last closed tab
      if (mod && shiftKey && key === "T") {
        e.preventDefault();
        reopenLastClosed();
        return;
      }

      // Ctrl+Shift+F — focus mode (Phase 3)
      if (mod && shiftKey && key === "F") {
        e.preventDefault();
        document.documentElement.classList.toggle("focus-mode");
        return;
      }

      // Ctrl+1..9 — switch to tab by index
      if (mod && /^[1-9]$/.test(key)) {
        e.preventDefault();
        switchToTabIndex(parseInt(key) - 1);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeTab, nextTab, previousTab, switchToTabIndex, toggleTabBar, reopenLastClosed]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden rounded-xl">
      <TitleBar />
      {tabBarVisible ? (
        <TabBar />
      ) : (
        tabs.length > 0 && (
          <button
            onClick={toggleTabBar}
            className="flex items-center justify-center h-1.5 bg-muted/30 hover:bg-muted/60 transition-colors group shrink-0"
            title="Show tab bar (Ctrl+Shift+B)"
          >
            <PanelTop className="w-3 h-3 text-muted-foreground/30 group-hover:text-muted-foreground/80 transition-colors" />
          </button>
        )
      )}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto bg-muted/30" style={{ overflowAnchor: "none" }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
