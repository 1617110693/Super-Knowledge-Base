/**
 * Shared image resolution via Tauri IPC.
 * Caches object URLs keyed by filename for reuse.
 */
import { shallowRef } from "vue";
import { readDocumentImage } from "@/services/tauriBridge";

const _imgCache = new Map<string, string>();

/** Monotonically incrementing counter — drives re-render across components */
export const imageVersion = shallowRef(0);

/** Get resolved URL if available, null otherwise */
export function getImageUrl(fn: string): string | null {
  return _imgCache.get(fn) ?? null;
}

async function _loadOne(fn: string, candidates: { kb_id: string; doc_id: string }[]) {
  if (_imgCache.has(fn)) return;
  for (const { kb_id, doc_id } of candidates) {
    try {
      const bytes = await readDocumentImage(kb_id, doc_id, fn);
      const blob = new Blob([new Uint8Array(bytes)]);
      const url = URL.createObjectURL(blob);
      _imgCache.set(fn, url);
      imageVersion.value = Date.now();
      return;
    } catch (e) {
      // continue to next candidate
    }
  }
  // Remove from _loading so it can be retried later (e.g. when new sources arrive)
  _loading.delete(fn);
}

const _loading = new Set<string>();

export function ensureImagesLoaded(
  content: string,
  candidates: { kb_id: string; doc_id: string }[],
) {
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  for (let m; (m = re.exec(content)) !== null; ) {
    const fn = m[1].replace(/\\/g, "/").split("/").pop();
    if (!fn || _imgCache.has(fn) || _loading.has(fn)) continue;
    _loading.add(fn);
    _loadOne(fn, candidates);
  }
}
