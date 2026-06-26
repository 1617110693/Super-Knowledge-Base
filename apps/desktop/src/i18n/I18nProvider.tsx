import { useState, useEffect, useCallback } from "react";
import { I18nContext, createT } from "./index";
import type { Lang } from "./translations";

const STORAGE_KEY = "skb-lang";

function getInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch {}
  // Detect browser language
  const nav = navigator.language;
  if (nav.startsWith("zh")) return "zh-CN";
  return "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(getInitialLang);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);
  const t = useCallback(createT(lang), [lang]);

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}
