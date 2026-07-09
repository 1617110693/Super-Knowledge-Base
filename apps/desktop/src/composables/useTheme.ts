import { useUiStore } from "@/stores/ui";

export function useTheme() {
  const ui = useUiStore();
  return {
    theme: ui.theme,
    resolvedTheme: ui.resolvedTheme,
    setTheme: ui.setTheme,
    cycleTheme: ui.cycleTheme,
    initTheme: ui.initTheme,
  };
}
