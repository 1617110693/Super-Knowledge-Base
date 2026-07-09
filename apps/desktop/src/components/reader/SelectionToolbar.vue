<script setup lang="ts">
import { ref } from "vue";
import { useAnnotationStore, type Rect, HIGHLIGHT_COLORS } from "@/stores/annotations";
import { useI18n } from "@/composables/useI18n";
import { PhHighlighter, PhTextUnderline, PhTextStrikethrough, PhChatText } from "@phosphor-icons/vue";

const emit = defineEmits<{ hide: [] }>();
const ann = useAnnotationStore();
const { t } = useI18n();

const visible = ref(false);
const x = ref(0);
const y = ref(0);
const selectedRects = ref<Rect[]>([]);
const selectedPage = ref(1);
const showNoteInput = ref(false);
const noteContent = ref("");

function show(posX: number, posY: number, rects: Rect[], pageNum: number) {
  x.value = Math.max(20, posX);
  y.value = Math.max(20, posY - 48);
  selectedRects.value = rects;
  selectedPage.value = pageNum;
  visible.value = true;
  showNoteInput.value = false;
  noteContent.value = "";
}

function hide() {
  visible.value = false;
  selectedRects.value = [];
  showNoteInput.value = false;
  emit("hide");
}

function handleHighlight() {
  if (selectedRects.value.length > 0) {
    ann.addHighlight(selectedPage.value, selectedRects.value);
  }
  hide();
}

function handleUnderline() {
  if (selectedRects.value.length > 0) {
    ann.addUnderline(selectedPage.value, selectedRects.value);
  }
  hide();
}

function handleStrikethrough() {
  if (selectedRects.value.length > 0) {
    ann.addStrikethrough(selectedPage.value, selectedRects.value);
  }
  hide();
}

function toggleNoteInput() {
  showNoteInput.value = !showNoteInput.value;
  noteContent.value = "";
}

function saveNote() {
  if (!noteContent.value.trim()) return;
  if (selectedRects.value.length > 0) {
    const r = selectedRects.value[0];
    ann.addNote(selectedPage.value, { x: r.x1, y: r.y1 }, noteContent.value.trim(), r);
  }
  hide();
}

defineExpose({ show, hide });
</script>

<template>
  <Teleport to="body">
    <Transition name="toolbar-fade">
      <div
        v-if="visible"
        class="selection-toolbar"
        :style="{ left: `${x}px`, top: `${y}px`, transform: 'translateX(-50%)' }"
        @click.stop
      >
        <!-- Note input -->
        <template v-if="showNoteInput">
          <textarea
            v-model="noteContent"
            class="note-textarea"
            :placeholder="t('note_placeholder')"
            rows="2"
            @keydown.escape="showNoteInput = false"
            @keydown.enter.exact.prevent="saveNote"
            autofocus
          />
          <button class="toolbar-btn note-save" :title="t('save_note')" @click="saveNote">
            {{ t('save') }}
          </button>
        </template>

        <!-- Annotation buttons -->
        <template v-else>
          <!-- Color picker row -->
          <div class="color-row">
            <button
              v-for="(color, i) in HIGHLIGHT_COLORS"
              :key="i"
              class="color-swatch"
              :class="{ active: ann.defaultColor === color }"
              :style="{ background: color }"
              @click="ann.setDefaultColor(color)"
            />
          </div>
          <span class="toolbar-divider" />
          <button class="toolbar-btn" :title="t('highlight')" @click="handleHighlight">
            <PhHighlighter :size="15" weight="fill" />
          </button>
          <button class="toolbar-btn" :title="t('underline')" @click="handleUnderline">
            <PhTextUnderline :size="15" />
          </button>
          <button class="toolbar-btn" :title="t('strikethrough')" @click="handleStrikethrough">
            <PhTextStrikethrough :size="15" />
          </button>
          <span class="toolbar-divider" />
          <button class="toolbar-btn" :title="t('add_note')" @click="toggleNoteInput">
            <PhChatText :size="15" />
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.selection-toolbar {
  position: fixed;
  z-index: 1000;
  display: flex;
  gap: 2px;
  padding: 5px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  align-items: center;
  flex-wrap: nowrap;
}

.color-row {
  display: flex;
  gap: 3px;
  align-items: center;
}

.color-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--border);
  cursor: pointer;
  padding: 0;
  transition: transform 100ms ease, border-color 100ms ease;
}

.color-swatch:hover {
  transform: scale(1.15);
}

.color-swatch.active {
  border-color: var(--accent);
  border-width: 2px;
}

.toolbar-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: none;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 150ms ease, color 150ms ease;
}

.toolbar-btn:hover {
  color: var(--text-primary);
  background: var(--accent-muted);
}

.toolbar-divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 2px;
  flex-shrink: 0;
}

.note-textarea {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: "Geist", sans-serif;
  color: var(--text-primary);
  background: var(--surface);
  resize: none;
  outline: none;
  width: 200px;
}

.note-textarea:focus {
  border-color: var(--accent);
}

.note-save {
  color: var(--accent) !important;
  font-size: 11px;
  font-weight: 500;
  width: auto;
  padding: 0 10px;
}

.toolbar-fade-enter-active,
.toolbar-fade-leave-active {
  transition: opacity 150ms ease, transform 150ms cubic-bezier(0.16, 1, 0.3, 1);
}

.toolbar-fade-enter-from,
.toolbar-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px) scale(0.95);
}
</style>
