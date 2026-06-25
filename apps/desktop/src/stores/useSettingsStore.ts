import { create } from "zustand";
import type { AppSettings } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import * as tauriBridge from "../services/tauriBridge";

function extractError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.toString === "function" && obj.toString !== Object.prototype.toString) {
      return obj.toString();
    }
    // Tauri often stringifies the error in the invoke wrapper
    try { return JSON.stringify(e); } catch { return "Unknown error"; }
  }
  return String(e ?? "Unknown error");
}

interface SettingsState {
  settings: AppSettings;
  loading: boolean;
  pythonRunning: boolean;
  pythonUrl: string;
  pythonError: string | null;

  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  startPython: () => Promise<void>;
  restartPython: () => Promise<void>;
  checkPythonStatus: () => Promise<boolean>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loading: false,
  pythonRunning: false,
  pythonUrl: "",
  pythonError: null,

  loadSettings: async () => {
    set({ loading: true });
    try {
      const settings = await tauriBridge.getSettings();
      set({ settings, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  saveSettings: async (newSettings: AppSettings) => {
    const settings = await tauriBridge.updateSettings(newSettings);
    set({ settings });
  },

  startPython: async () => {
    try {
      const status = await tauriBridge.startPythonBackend();
      set({
        pythonRunning: status.running,
        pythonUrl: status.url,
        pythonError: status.error || null,
      });
    } catch (e) {
      set({ pythonRunning: false, pythonError: extractError(e) });
    }
  },

  restartPython: async () => {
    set({ pythonRunning: false, pythonError: null });
    try {
      const status = await tauriBridge.restartPythonBackend();
      set({
        pythonRunning: status.running,
        pythonUrl: status.url,
        pythonError: status.error || null,
      });
    } catch (e) {
      set({ pythonRunning: false, pythonError: extractError(e) });
    }
  },

  checkPythonStatus: async () => {
    try {
      const status = await tauriBridge.getPythonBackendStatus();
      set({
        pythonRunning: status.running,
        pythonUrl: status.url,
        pythonError: status.error || null,
      });
      return status.running;
    } catch (e) {
      set({ pythonRunning: false, pythonError: extractError(e) });
      return false;
    }
  },
}));
