<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from "vue";
import { useDocumentStore } from "@/stores/document";
import { useI18n } from "@/composables/useI18n";

const doc = useDocumentStore();
const { t } = useI18n();
const thumbRef = ref<HTMLDivElement | null>(null);
const rendering = ref(false);

let THUMB_SCALE = 0.25;

async function renderThumbnails() {
  const pdf = doc.pdfDoc;
  if (!pdf || !thumbRef.value) return;
  rendering.value = true;
  const dpr = window.devicePixelRatio || 1;
  const renderScale = THUMB_SCALE * dpr;

  thumbRef.value.innerHTML = "";

  for (let p = 1; p <= pdf.numPages; p++) {
    const wrapper = document.createElement("button");
    wrapper.className = "thumbnail-card";
    wrapper.dataset.page = String(p);
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.padding = "6px";
    wrapper.style.cursor = "pointer";
    wrapper.style.background = "var(--surface)";
    wrapper.style.borderRadius = "var(--radius)";
    wrapper.style.border = "2px solid transparent";
    wrapper.style.transition = "border-color 150ms ease";

    wrapper.addEventListener("click", () => doc.setPage(p));

    const canvas = document.createElement("canvas");
    canvas.style.borderRadius = "2px";
    canvas.style.marginBottom = "4px";

    try {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: renderScale });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.style.width = `100%`;
      canvas.style.height = `auto`;

      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch {
      // Fallback: show page number
      canvas.width = 100;
      canvas.height = 141;
      canvas.style.width = "100%";
    }

    wrapper.appendChild(canvas);

    const label = document.createElement("span");
    label.className = "text-xs";
    label.style.color = "var(--text-muted)";
    label.textContent = String(p);
    wrapper.appendChild(label);

    if (!thumbRef.value) break;
    thumbRef.value.appendChild(wrapper);
  }
  rendering.value = false;
}

// Highlight active page on change
watch(() => doc.currentPage, () => {
  if (!thumbRef.value) return;
  thumbRef.value.querySelectorAll(".thumbnail-card").forEach((el) => {
    const card = el as HTMLElement;
    const page = card.dataset.page;
    card.style.borderColor = page === String(doc.currentPage) ? "var(--accent)" : "transparent";
  });
});

// Trigger render when pdfDoc changes
watch(() => doc.pdfDoc, () => {
  if (doc.pdfDoc) nextTick(renderThumbnails);
});

onMounted(() => {
  if (doc.pdfDoc) renderThumbnails();
});
</script>

<template>
  <div class="thumbnail-panel">
    <div v-if="!doc.pdfDoc || doc.pageCount === 0" class="empty-label text-[var(--text-muted)] text-xs">
      {{ t('thumbnails_empty') }}
    </div>
    <div v-else ref="thumbRef" class="thumbnail-grid" />
  </div>
</template>

<style scoped>
.thumbnail-panel {
  font-size: 12px;
}

.empty-label {
  text-align: center;
  padding-top: 24px;
}

.thumbnail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.thumbnail-card:hover {
  border-color: var(--border-hover) !important;
}
</style>
