<template>
  <slot v-if="!hasError" />
  <div v-else class="error-boundary">
    <div class="error-boundary-content">
      <p class="error-boundary-text">{{ t("error.generic") }}</p>
      <el-button size="small" @click="reset">{{ t("kb.retry") }}</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue'
import { useI18n } from "@/i18n/index";

const { t } = useI18n();

const hasError = ref(false)

onErrorCaptured(() => {
  hasError.value = true
  return false
})

function reset() {
  hasError.value = false
}
</script>

<style scoped>
.error-boundary {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  padding: 24px;
}

.error-boundary-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.error-boundary-text {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}
</style>
