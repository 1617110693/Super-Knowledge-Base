<template>
  <div class="relative">
    <button
      class="text-xs border rounded-md px-2 py-1 bg-background min-w-[100px] max-w-[180px] truncate text-left flex items-center gap-1"
      @click="open = !open"
    >
      <span v-if="selectedKbIds.length === 0">{{ noKbLabel }}</span>
      <span v-else-if="selectedKbIds.length === 1">{{ kbNameById(selectedKbIds[0]) }}</span>
      <span v-else>{{ kbCountLabel(selectedKbIds.length) }}</span>
      <ChevronDown class="w-3 h-3 ml-auto shrink-0" />
    </button>
    <Teleport to="body">
      <div v-if="open" class="fixed inset-0 z-40" @click="open = false" />
      <div
        v-if="open"
        class="absolute top-full right-0 mt-1 z-50 bg-card border rounded-lg shadow-lg p-1.5 min-w-[200px] max-h-[280px] overflow-y-auto"
      >
        <label class="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded cursor-pointer text-xs">
          <input type="checkbox" :checked="selectedKbIds.length === 0" @change="$emit('clearAll')" />
          <span class="text-muted-foreground">{{ noKbLabel }}</span>
        </label>
        <hr class="my-1 border-border/50" />
        <label
          v-for="kb in kbs"
          :key="kb.id"
          class="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded cursor-pointer text-xs"
        >
          <input
            type="checkbox"
            :checked="selectedKbIds.includes(kb.id)"
            @change="$emit('toggle', kb.id)"
          />
          <span class="truncate">{{ kb.name }}</span>
          <span class="text-[10px] text-muted-foreground/60 ml-auto shrink-0">{{ kb.document_count }}</span>
        </label>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ChevronDown } from "lucide-vue-next";
import type { KnowledgeBase } from "@/types";

const props = defineProps<{
  kbs: KnowledgeBase[];
  selectedKbIds: string[];
  noKbLabel: string;
  kbCountLabel: (count: number) => string;
}>();

defineEmits<{
  toggle: [id: string];
  clearAll: [];
}>();

const open = ref(false);

function kbNameById(id: string): string {
  return props.kbs.find((kb) => kb.id === id)?.name || id;
}
</script>