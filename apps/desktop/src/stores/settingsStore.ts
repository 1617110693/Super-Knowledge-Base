import { defineStore } from "pinia";
import { ref } from "vue";
import type { AppSettings } from "@/types";
import { DEFAULT_SETTINGS } from "@/types";
import * as tauriBridge from "@/services/tauriBridge";

export const useSettingsStore = defineStore("settings", () => {
  const settings = ref<AppSettings>(DEFAULT_SETTINGS);
  const loading = ref(false);
  const pythonRunning = ref(false);
  const pythonUrl = ref("");
  const pythonError = ref<string | null>(null);

  async function loadSettings() {
    loading.value = true;
    try { settings.value = await tauriBridge.getSettings(); } catch {}
    loading.value = false;
  }

  async function saveSettings(newSettings: AppSettings) {
    settings.value = await tauriBridge.updateSettings(newSettings);
  }

  async function startPython() {
    try {
      const status = await tauriBridge.startPythonBackend();
      pythonRunning.value = status.running;
      pythonUrl.value = status.url;
      pythonError.value = status.error || null;
    } catch (e: any) {
      pythonRunning.value = false;
      pythonError.value = String(e?.message ?? e);
    }
  }

  async function restartPython() {
    pythonRunning.value = false;
    pythonError.value = null;
    try {
      const status = await tauriBridge.restartPythonBackend();
      pythonRunning.value = status.running;
      pythonUrl.value = status.url;
      pythonError.value = status.error || null;
    } catch (e: any) {
      pythonRunning.value = false;
      pythonError.value = String(e?.message ?? e);
    }
  }

  async function checkPythonStatus(): Promise<boolean> {
    try {
      const status = await tauriBridge.getPythonBackendStatus();
      pythonRunning.value = status.running;
      pythonUrl.value = status.url;
      pythonError.value = status.error || null;
      return status.running;
    } catch (e: any) {
      pythonRunning.value = false;
      pythonError.value = String(e?.message ?? e);
      return false;
    }
  }

  return {
    settings, loading, pythonRunning, pythonUrl, pythonError,
    loadSettings, saveSettings, startPython, restartPython, checkPythonStatus,
  };
});
