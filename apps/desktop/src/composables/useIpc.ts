import { invoke } from "@tauri-apps/api/core";

/**
 * Safe wrapper around Tauri invoke. Returns null on error
 * so callers can handle failures gracefully.
 */
export async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    console.error(`IPC call "${cmd}" failed:`, e);
    return null;
  }
}

export function useIpc() {
  return { invoke: safeInvoke };
}
