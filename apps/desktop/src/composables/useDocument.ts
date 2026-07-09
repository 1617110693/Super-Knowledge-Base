import { ref, shallowRef } from "vue";
import { getDocumentContent } from "@/services/tauriBridge";
import type { DocumentContent } from "@/types";

export function useDocument(kbId: string, docId: string) {
  const content = shallowRef<DocumentContent | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      content.value = await getDocumentContent(kbId, docId);
    } catch (e) {
      error.value = String(e);
      content.value = null;
    } finally {
      loading.value = false;
    }
  }

  return { content, loading, error, load };
}
