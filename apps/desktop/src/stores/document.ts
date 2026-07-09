import { defineStore } from "pinia";
import { ref } from "vue";

export interface OutlineItem {
  title: string;
  level: number;
  page: number;
}

export const useDocumentStore = defineStore("document", () => {
  const document = ref<any>(null);
  const pdfDoc = ref<any>(null);
  const currentPage = ref(1);
  const pageCount = ref(0);
  const zoom = ref(1.0);
  const outline = ref<OutlineItem[]>([]);

  function setPage(page: number) {
    if (page >= 1 && page <= pageCount.value) {
      currentPage.value = page;
    }
  }

  function setZoom(level: number) {
    zoom.value = Math.max(0.25, Math.min(5.0, level));
  }

  return {
    document,
    pdfDoc,
    currentPage,
    pageCount,
    zoom,
    outline,
    setPage,
    setZoom,
  };
});
