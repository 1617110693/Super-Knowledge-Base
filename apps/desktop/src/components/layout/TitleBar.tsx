import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Globe, Sun, Moon, Monitor, BookOpen, PanelTop } from "lucide-react";
import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTabStore } from "../../stores/useTabStore";
import { UserGuideDialog } from "../common/UserGuideDialog";

type Theme = "light" | "dark" | "system";

const THEME_ICONS: Record<Theme, React.ReactNode> = {
  light: <Sun className="w-3.5 h-3.5" />,
  dark: <Moon className="w-3.5 h-3.5" />,
  system: <Monitor className="w-3.5 h-3.5" />,
};

const THEME_NEXT: Record<Theme, Theme> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const THEME_TITLES: Record<Theme, string> = {
  light: "浅色模式",
  dark: "深色模式",
  system: "跟随系统",
};

function useTheme() {
  const theme = useSettingsStore((s) => s.settings.theme) as Theme;
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const settings = useSettingsStore((s) => s.settings);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const apply = () => {
      const isDark = theme === "dark" || (theme === "system" && media.matches);
      root.classList.toggle("dark", isDark);
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const cycle = () => {
    const next = THEME_NEXT[theme];
    saveSettings({ ...settings, theme: next });
  };

  return { theme, cycle };
}

export function TitleBar() {
  const win = getCurrentWindow();
  const { t, lang, setLang } = useI18n();
  const { theme, cycle } = useTheme();
  const tabBarVisible = useTabStore((s) => s.tabBarVisible);
  const tabsCount = useTabStore((s) => s.tabs.length);
  const toggleTabBar = useTabStore((s) => s.toggleTabBar);

  const [showGuide, setShowGuide] = useState(false);
  const [checkedFirstLaunch, setCheckedFirstLaunch] = useState(false);

  // First-launch detection: if settings are all at defaults, auto-open the guide
  useEffect(() => {
    if (checkedFirstLaunch) return;
    const s = useSettingsStore.getState().settings;
    const isFresh = !s.embedding_api_key && !s.mineru_token && !s.llm_api_key;
    if (isFresh) {
      setCheckedFirstLaunch(true);
      // Small delay so the UI is ready
      const timer = setTimeout(() => setShowGuide(true), 600);
      return () => clearTimeout(timer);
    }
    setCheckedFirstLaunch(true);
  }, [checkedFirstLaunch]);

  const toggleLang = () => setLang(lang === "en" ? "zh-CN" : "en");

  return (
    <div
      data-tauri-drag-region
      className="title-bar flex items-center justify-between h-9 bg-card border-b shrink-0 select-none"
    >
      <div className="flex items-center gap-2 pl-3">
        <span className="text-xs font-medium text-muted-foreground">
          {t("app.title")}
        </span>
      </div>

      <div className="flex h-full">
        <button
          onClick={() => setShowGuide(true)}
          className="w-10 h-full flex items-center justify-center hover:bg-muted transition-colors"
          title={t("app.guide")}
        >
          <BookOpen className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
        {tabsCount > 0 && (
          <button
            onClick={toggleTabBar}
            className={`w-10 h-full flex items-center justify-center hover:bg-muted transition-colors ${!tabBarVisible ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
            title={tabBarVisible ? "Hide tab bar" : "Show tab bar"}
          >
            <PanelTop className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={() => cycle()}
          className="w-10 h-full flex items-center justify-center hover:bg-muted transition-colors"
          title={THEME_TITLES[theme]}
        >
          {THEME_ICONS[theme]}
        </button>
        <button
          onClick={toggleLang}
          className="w-10 h-full flex items-center justify-center hover:bg-muted transition-colors text-xs font-medium text-muted-foreground"
          title={lang === "en" ? "切换到中文" : "Switch to English"}
        >
          <Globe className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => win.minimize()}
          className="w-10 h-full flex items-center justify-center hover:bg-muted transition-colors"
        >
          <Minus className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
        <button
          onClick={() => win.toggleMaximize()}
          className="w-10 h-full flex items-center justify-center hover:bg-muted transition-colors"
        >
          <Square className="w-3 h-3 text-muted-foreground" />
        </button>
        <button
          onClick={() => win.close()}
          className="w-10 h-full flex items-center justify-center hover:bg-red-500 hover:text-white transition-colors"
        >
          <X className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>
      {showGuide && <UserGuideDialog onClose={() => setShowGuide(false)} />}
    </div>
  );
}
