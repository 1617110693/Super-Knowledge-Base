import { ref } from "vue";

type Locale = "zh" | "en";

const LOCALE_KEY = "pdfreader-locale";

const dict: Record<Locale, Record<string, string>> = {
  zh: {
    "open": "打开",
    "minimize": "最小化",
    "maximize": "最大化",
    "close": "关闭",
    "toggle_theme": "切换主题",
    "toggle_lang": "切换语言",
    "empty_title": "打开 PDF 开始阅读",
    "empty_hint": "Ctrl+O 或拖拽文件",
    "outline_empty": "暂无目录",
    "bookmarks_empty": "暂无书签",
    "bookmarks_hint": "按 Ctrl+D 添加书签",
    "remove_bookmark": "删除书签",
    "search_placeholder": "搜索文档...",
    "searching": "搜索中...",
    "search_no_results": "未找到结果",
    "search_type_hint": "输入关键词搜索",
    "thumbnails_empty": "暂无页面",
    "open_file": "打开",
    "read": "阅读",
    "settings": "设置",
    "about": "关于",
    "highlight": "高亮",
    "underline": "下划线",
    "strikethrough": "删除线",
    "add_note": "添加笔记",
    "note_placeholder": "输入笔记内容...",
    "save": "保存",
    "save_note": "保存笔记",
    "delete": "删除",
    "edit_note": "编辑笔记",
    "delete_note": "删除笔记",
    "switch_color": "切换颜色",
    "add_bookmark": "添加书签",
    "pen_mode": "画笔模式",
    "doodle_mode": "涂鸦模式",
  },
  en: {
    "open": "Open",
    "minimize": "Minimize",
    "maximize": "Maximize",
    "close": "Close",
    "toggle_theme": "Toggle theme",
    "toggle_lang": "Toggle language",
    "empty_title": "Open a PDF to start reading",
    "empty_hint": "Ctrl+O or drag and drop",
    "outline_empty": "No outline available",
    "bookmarks_empty": "No bookmarks yet",
    "bookmarks_hint": "Press Ctrl+D to add a bookmark",
    "remove_bookmark": "Remove bookmark",
    "search_placeholder": "Search in document...",
    "searching": "Searching...",
    "search_no_results": "No results found",
    "search_type_hint": "Type to search",
    "thumbnails_empty": "No pages loaded",
    "open_file": "Open File",
    "read": "Read",
    "settings": "Settings",
    "about": "About",
    "highlight": "Highlight",
    "underline": "Underline",
    "strikethrough": "Strikethrough",
    "add_note": "Add note",
    "note_placeholder": "Type note content...",
    "save": "Save",
    "save_note": "Save note",
    "delete": "Delete",
    "edit_note": "Edit note",
    "delete_note": "Delete note",
    "switch_color": "Switch color",
    "add_bookmark": "Add bookmark",
    "pen_mode": "Pen mode",
    "doodle_mode": "Doodle mode",
  },
};

const locale = ref<Locale>("zh");

function loadLocale() {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved === "zh" || saved === "en") locale.value = saved;
  } catch {}
}

function saveLocale() {
  try { localStorage.setItem(LOCALE_KEY, locale.value); } catch {}
}

function t(key: string): string {
  return dict[locale.value][key] ?? key;
}

function toggleLocale() {
  locale.value = locale.value === "zh" ? "en" : "zh";
  saveLocale();
}

// Load saved locale on init
loadLocale();

export function useI18n() {
  return { locale, t, toggleLocale };
}
