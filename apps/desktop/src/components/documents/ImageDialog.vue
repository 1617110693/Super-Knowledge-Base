<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  visible: boolean;
  src: string;
  alt: string;
}>();

const emit = defineEmits<{
  (e: "update:visible", val: boolean): void;
}>();
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="Image Preview"
    width="auto"
    :close-on-click-modal="true"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
  >
    <div class="image-container" v-if="src">
      <img :src="src" :alt="alt || 'Image preview'" class="preview-image" />
      <p v-if="alt" class="image-caption">{{ alt }}</p>
    </div>
    <div v-else class="image-empty">
      <p>No image available</p>
    </div>
  </el-dialog>
</template>

<style scoped>
.image-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 80vw;
  max-height: 80vh;
}

.preview-image {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
  border-radius: 4px;
}

.image-caption {
  font-size: 13px;
  color: var(--text-secondary);
  text-align: center;
  margin: 0;
}

.image-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: var(--text-secondary);
}
</style>
