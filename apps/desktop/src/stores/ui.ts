import { defineStore } from "pinia";
import { ref, computed } from "vue";

export type ThemeMode = "light" | "dark" | "system";
export type PanelTab = "outline" | "thumbnails" | "bookmarks" | "search";

export const useUiStore = defineStore("ui", () => {
  // ── Theme ──
  const theme = ref<ThemeMode>("system");
  const resolvedTheme = ref<"light" | "dark">("light");

  function applyTheme(mode: ThemeMode) {
    if (mode === "system") {
      resolvedTheme.value = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      resolvedTheme.value = mode;
    }
    document.documentElement.setAttribute("data-theme", resolvedTheme.value);
  }

  function setTheme(mode: ThemeMode) {
    theme.value = mode;
    applyTheme(mode);
    try { localStorage.setItem("skb-theme", mode); } catch { /* noop */ }
  }

  function cycleTheme() {
    const modes: ThemeMode[] = ["light", "dark", "system"];
    const idx = modes.indexOf(theme.value);
    setTheme(modes[(idx + 1) % modes.length]);
  }

  function initTheme() {
    try {
      const saved = localStorage.getItem("skb-theme") as ThemeMode | null;
      if (saved && ["light", "dark", "system"].includes(saved)) {
        theme.value = saved;
      }
    } catch { /* noop */ }
    applyTheme(theme.value);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (theme.value === "system") applyTheme("system");
    });
  }

  // ── Slide panel ──
  const activePanel = ref<PanelTab | null>(null);

  function togglePanel(tab: PanelTab) {
    activePanel.value = activePanel.value === tab ? null : tab;
  }

  // ── Annotation modes (PDF viewer) ──
  const penMode = ref(false);
  const doodleMode = ref(false);

  return {
    theme,
    resolvedTheme,
    activePanel,
    penMode,
    doodleMode,
    setTheme,
    cycleTheme,
    initTheme,
    togglePanel,
  };
});
