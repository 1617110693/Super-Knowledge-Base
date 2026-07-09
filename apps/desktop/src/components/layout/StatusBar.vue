<script setup lang="ts">
import { ref, watch } from "vue";
import { useDocumentStore } from "@/stores/document";

const doc = useDocumentStore();
const pageInput = ref(String(doc.currentPage));
const inputRef = ref<HTMLInputElement | null>(null);
const zoomInput = ref(String(Math.round(doc.zoom * 100)));
const zoomInputRef = ref<HTMLInputElement | null>(null);

// Sync input when page changes externally
watch(() => doc.currentPage, (p) => {
  pageInput.value = String(p);
});

// Sync zoom input when zoom changes externally
watch(() => doc.zoom, (z) => {
  zoomInput.value = String(Math.round(z * 100));
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitPage();
  } else if (e.key === "Escape") {
    pageInput.value = String(doc.currentPage);
    inputRef.value?.blur();
  }
}

function commitPage() {
  const n = parseInt(pageInput.value, 10);
  if (!isNaN(n) && n >= 1 && n <= doc.pageCount) {
    doc.setPage(n);
  } else {
    pageInput.value = String(doc.currentPage);
  }
  inputRef.value?.blur();
}

function onZoomKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitZoom();
  } else if (e.key === "Escape") {
    zoomInput.value = String(Math.round(doc.zoom * 100));
    zoomInputRef.value?.blur();
  }
}

function commitZoom() {
  const n = parseInt(zoomInput.value, 10);
  if (!isNaN(n)) {
    const zoom = Math.max(0.5, Math.min(4.0, n / 100));
    doc.setZoom(zoom);
  }
  zoomInput.value = String(Math.round(doc.zoom * 100));
  zoomInputRef.value?.blur();
}

function onPageFocus(e: FocusEvent) {
  (e.target as HTMLInputElement)?.select();
}

function onZoomFocus(e: FocusEvent) {
  (e.target as HTMLInputElement)?.select();
}
</script>

<template>
  <div class="status-bar">
    <input
      ref="inputRef"
      v-model="pageInput"
      class="page-input"
      type="text"
      inputmode="numeric"
      :maxlength="String(doc.pageCount).length"
      @keydown="onKeydown"
      @blur="commitPage"
      @focus="onPageFocus"
    />
    <span class="text-[var(--border)]">/</span>
    <span class="status-mono">
      {{ doc.pageCount || "-" }}
    </span>
    <span class="status-divider" />
    <button class="zoom-btn" @click="doc.setZoom(doc.zoom - 0.1)" :disabled="doc.zoom <= 0.5" title="-">&minus;</button>
    <input
      ref="zoomInputRef"
      v-model="zoomInput"
      class="zoom-input"
      type="text"
      inputmode="numeric"
      maxlength="3"
      @keydown="onZoomKeydown"
      @blur="commitZoom"
      @focus="onZoomFocus"
    />
    <span class="status-mono">%</span>
    <button class="zoom-btn" @click="doc.setZoom(doc.zoom + 0.1)" :disabled="doc.zoom >= 4.0" title="+">+</button>
  </div>
</template>

<style scoped>
.status-bar {
  height: var(--status-bar-height);
  background: var(--surface-raised);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  flex-shrink: 0;
  font-size: 12px;
}

.page-input {
  width: 42px;
  text-align: center;
  font-family: "Geist Mono", monospace;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 4px;
  outline: none;
  transition: border-color 150ms;
}

.page-input:focus {
  border-color: var(--accent);
  color: var(--text-primary);
}

.page-input::-webkit-inner-spin-button,
.page-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.zoom-input {
  width: 36px;
  text-align: center;
  font-family: "Geist Mono", monospace;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 4px;
  outline: none;
  transition: border-color 150ms;
}

.zoom-input:focus {
  border-color: var(--accent);
  color: var(--text-primary);
}

.zoom-input::-webkit-inner-spin-button,
.zoom-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.status-mono {
  font-family: "Geist Mono", monospace;
  color: var(--text-muted);
}

.status-divider {
  width: 1px;
  height: 14px;
  background: var(--border);
}

.zoom-btn {
  width: 20px;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 150ms, color 150ms, border-color 150ms;
  padding: 0;
}

.zoom-btn:hover:not(:disabled) {
  background: var(--accent-muted);
  color: var(--text-primary);
  border-color: var(--accent);
}

.zoom-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
