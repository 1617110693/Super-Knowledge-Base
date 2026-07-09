import { ref } from "vue";
import type { App } from "vue";
import { translations, type Lang } from "./translations";

const LOCALE_KEY = "skb-locale";

function getInitialLocale(): Lang {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch {}
  return navigator.language.startsWith("zh") ? "zh-CN" : "en";
}

const locale = ref<Lang>(getInitialLocale());

export function useI18n() {
  function t(key: string, params?: Record<string, string | number> | string, fallback?: string): string {
    // If params is a string, treat it as fallback (backward compat)
    if (typeof params === "string") {
      fallback = params;
      params = undefined;
    }
    const entry = (translations as any)[key];
    if (!entry) return fallback || key;
    let text = entry[locale.value] ?? entry.en ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  }

  function setLocale(lang: Lang) {
    locale.value = lang;
    try { localStorage.setItem(LOCALE_KEY, lang); } catch {}
    document.documentElement.lang = lang;
  }

  function toggleLocale() {
    setLocale(locale.value === "en" ? "zh-CN" : "en");
  }

  return { t, locale, setLocale, toggleLocale };
}

// Vue plugin for app.use()
export default {
  install(app: App) {
    const i18n = useI18n();
    app.provide("i18n", i18n);
    app.config.globalProperties.$t = i18n.t;
  },
};
