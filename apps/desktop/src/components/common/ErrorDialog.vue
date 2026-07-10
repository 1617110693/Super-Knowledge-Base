<template>
  <el-dialog
    :model-value="visible"
    :title="title"
    width="480px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <div class="error-dialog-body">
      <el-alert
        :title="message"
        type="error"
        :closable="false"
        show-icon
      />
      <div
        v-if="error"
        class="error-detail"
      >
        <el-button
          size="small"
          type="warning"
          plain
          @click="detailExpanded = !detailExpanded"
        >
          {{ detailExpanded ? '收起详情' : '查看详情' }}
        </el-button>
        <pre
          v-show="detailExpanded"
          class="error-stack"
        >{{ error }}</pre>
      </div>
    </div>
    <template #footer>
      <span class="dialog-footer">
        <el-button type="primary" @click="handleClose">关闭</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  visible: boolean
  title: string
  message: string
  error?: string
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

const detailExpanded = ref(false)

function handleClose() {
  detailExpanded.value = false
  emit('update:visible', false)
}
</script>

<style scoped>
.error-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.error-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.error-stack {
  margin: 0;
  padding: 12px;
  background-color: var(--el-fill-color-light);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow-y: auto;
}

</style>
