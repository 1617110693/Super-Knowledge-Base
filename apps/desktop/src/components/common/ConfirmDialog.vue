<template>
  <el-dialog
    :model-value="visible"
    :title="title"
    width="420px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <p class="confirm-message">{{ message }}</p>
    <template #footer>
      <span class="dialog-footer">
        <el-button @click="handleCancel">取消</el-button>
        <el-button
          :type="danger ? 'danger' : 'primary'"
          @click="handleConfirm"
        >
          确认
        </el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean
  title: string
  message: string
  danger?: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  confirm: []
  cancel: []
}>()

function handleConfirm() {
  emit('confirm')
  emit('update:visible', false)
}

function handleCancel() {
  emit('cancel')
  emit('update:visible', false)
}
</script>

<style scoped>
.confirm-message {
  margin: 0;
  line-height: 1.6;
  color: var(--el-text-color-primary);
}
</style>
