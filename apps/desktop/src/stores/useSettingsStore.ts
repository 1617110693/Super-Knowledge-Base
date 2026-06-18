import { create } from "zustand";
import type { AppSettings } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import * as tauriBridge from "../services/tauriBridge";

interface SettingsState {
  settings: AppSettings;
  loading: boolean;
  pythonRunning: boolean;
  pythonUrl: string;

  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  startPython: () => Promise<void>;
  checkPythonStatus: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loading: false,
  pythonRunning: false,
  pythonUrl: "",

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
      set({ pythonRunning: status.running, pythonUrl: status.url });
    } catch (e) {
      console.error("Failed to start Python backend:", e);
    }
  },

  checkPythonStatus: async () => {
    try {
      const status = await tauriBridge.getPythonBackendStatus();
      set({ pythonRunning: status.running, pythonUrl: status.url });
    } catch {
      set({ pythonRunning: false });
    }
  },
}));
