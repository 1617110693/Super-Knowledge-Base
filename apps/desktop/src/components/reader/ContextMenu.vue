<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from "vue";

export interface MenuItem {
  label: string;
  danger?: boolean;
  action: () => void;
}

const props = defineProps<{
  x: number;
  y: number;
  items: MenuItem[];
}>();

const emit = defineEmits<{ close: [] }>();

const menuRef = ref<HTMLDivElement | null>(null);
const adjustedX = ref(props.x);
const adjustedY = ref(props.y);

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    emit("close");
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

function handleScroll() {
  emit("close");
}

function handleItemClick(item: MenuItem) {
  item.action();
  emit("close");
}

onMounted(async () => {
  await nextTick();
  if (menuRef.value) {
    const rect = menuRef.value.getBoundingClientRect();
    if (props.x + rect.width > window.innerWidth) {
      adjustedX.value = window.innerWidth - rect.width - 8;
    }
    if (props.y + rect.height > window.innerHeight) {
      adjustedY.value = window.innerHeight - rect.height - 8;
    }
  }
  document.addEventListener("click", handleClickOutside, { capture: true });
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("scroll", handleScroll, { capture: true });
});

onUnmounted(() => {
  document.removeEventListener("click", handleClickOutside, { capture: true });
  document.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("scroll", handleScroll, { capture: true });
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="menuRef"
      class="context-menu"
      :style="{ left: adjustedX + 'px', top: adjustedY + 'px' }"
      @click.stop
    >
      <button
        v-for="(item, i) in items"
        :key="i"
        class="ctx-item"
        :class="{ danger: item.danger }"
        @click="handleItemClick(item)"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 140px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ctx-item {
  text-align: left;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 100ms ease, color 100ms ease;
}

.ctx-item:hover {
  background: var(--accent-muted);
  color: var(--text-primary);
}

.ctx-item.danger {
  color: #dc2626;
}

.ctx-item.danger:hover {
  background: rgba(220, 38, 38, 0.1);
  color: #dc2626;
}
</style>
