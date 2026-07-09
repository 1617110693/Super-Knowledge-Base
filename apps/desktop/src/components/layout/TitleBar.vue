<template>
  <div class="titlebar" @mousedown="onDrag">
    <div class="titlebar-left">
      <span class="titlebar-app-name">SKB</span>
    </div>

    <div class="titlebar-center">
      <slot name="center" />
    </div>

    <div class="titlebar-right">
      <!-- User Guide -->
      <button class="titlebar-icon-btn" title="Guide" @click="showGuide = true">
        <BookOpen :size="14" />
      </button>

      <!-- Theme Toggle -->
      <button class="titlebar-icon-btn" :title="themeTitle" @click="cycleTheme">
        <Sun v-if="theme === 'light'" :size="14" />
        <Moon v-else-if="theme === 'dark'" :size="14" />
        <Monitor v-else :size="14" />
      </button>

      <!-- Language Toggle -->
      <button
        class="titlebar-icon-btn titlebar-lang-btn"
        :title="locale === 'en' ? '切换到中文' : 'Switch to English'"
        @click="toggleLocale"
      >
        <Globe :size="14" />
      </button>

      <!-- Window Controls -->
      <button class="titlebar-win-btn" title="Minimize" @click="win.minimize()">
        <Minus :size="14" />
      </button>
      <button class="titlebar-win-btn" title="Maximize" @click="win.toggleMaximize()">
        <Square :size="12" />
      </button>
      <button class="titlebar-win-btn titlebar-win-btn-close" title="Close" @click="win.close()">
        <X :size="14" />
      </button>
    </div>

    <!-- User Guide Dialog -->
    <UserGuideDialog :visible="showGuide" @update:visible="showGuide = $event" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Sun, Moon, Monitor, Globe, BookOpen } from "lucide-vue-next";
import { useSettingsStore } from "@/stores/settingsStore";
import { useI18n } from "@/i18n/index";
import UserGuideDialog from "@/components/common/UserGuideDialog.vue";

const win = getCurrentWindow();
const settingsStore = useSettingsStore();
const { t, locale, toggleLocale } = useI18n();

const theme = ref<"light" | "dark" | "system">("system");
const showGuide = ref(false);

const themeTitle = ref("");

onMounted(async () => {
  // Sync theme from settings
  theme.value = (settingsStore.settings.theme as any) || "system";
  applyTheme();
  updateThemeTitle();

  // Watch for settings theme changes (from SettingsPanel)
  watch(() => settingsStore.settings.theme, (newTheme) => {
    theme.value = (newTheme as any) || "system";
    applyTheme();
    updateThemeTitle();
  });

  // First-launch detection
  const s = settingsStore.settings;
  const isFresh = !s.embedding_api_key && !s.mineru_token && !s.llm_api_key;
  if (isFresh && !s.has_seen_guide) {
    setTimeout(() => { showGuide.value = true; }, 600);
  }
});

// Persist has_seen_guide when the user closes the guide dialog
watch(() => showGuide.value, (val) => {
  if (!val) {
    settingsStore.saveSettings({ ...settingsStore.settings, has_seen_guide: true });
  }
});

function applyTheme() {
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const resolved = theme.value === "dark" || (theme.value === "system" && media.matches);
  root.classList.toggle("dark", resolved);
  root.setAttribute("data-theme", resolved ? "dark" : "light");
}

// Expose for SettingsPanel
defineExpose({ applyTheme, theme });

function cycleTheme() {
  const order: Array<"light" | "dark" | "system"> = ["light", "dark", "system"];
  const idx = order.indexOf(theme.value);
  theme.value = order[(idx + 1) % 3];
  applyTheme();
  updateThemeTitle();
  settingsStore.saveSettings({ ...settingsStore.settings, theme: theme.value });
}

function updateThemeTitle() {
  const titles: Record<string, string> = { light: "Light", dark: "Dark", system: "System" };
  themeTitle.value = titles[theme.value] || "Theme";
}

async function onDrag(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.closest("button, [role=\"button\"], .titlebar-icon-btn, .titlebar-win-btn")) return;
  try { await win.startDragging(); } catch {}
}
</script>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 36px;
  background: var(--surface);
  border-bottom: 1px solid var(--border-color);
  user-select: none;
  flex-shrink: 0;
  padding: 0 6px;
}

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 60px;
  padding-left: 8px;
}

.titlebar-app-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  letter-spacing: 0.3px;
}

.titlebar-center {
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 0;
  height: 100%;
}

.titlebar-right {
  display: flex;
  align-items: center;
  gap: 0;
  min-width: 180px;
  justify-content: flex-end;
}

.titlebar-icon-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

.titlebar-icon-btn:hover {
  background: var(--surface-raised);
  color: var(--text-primary);
}

.titlebar-icon-btn-active {
  background: var(--accent-muted);
  color: var(--accent-color);
}

.titlebar-lang-btn {
  font-size: 11px;
  font-weight: 500;
}

.titlebar-win-btn {
  width: 44px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

.titlebar-win-btn:hover {
  background: var(--surface-raised);
  color: var(--text-primary);
}

.titlebar-win-btn-close:hover {
  background: #e81123;
  color: #ffffff;
}
</style>