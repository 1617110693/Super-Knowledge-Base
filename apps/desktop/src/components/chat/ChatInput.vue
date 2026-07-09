<template>
  <div class="chat-input-container">
    <el-input
      v-model="inputText"
      type="textarea"
      :autosize="{ minRows: 1, maxRows: 6 }"
      :placeholder="placeholder"
      class="chat-textarea"
      :disabled="streaming"
      @keydown.enter.exact.prevent="handleSend"
    />
    <div class="chat-input-actions">
      <el-button
        v-if="streaming"
        type="danger"
        size="small"
        round
        class="stop-btn"
        @click="emit('stop')"
      >
        <Ban class="w-4 h-4 mr-1" />
        Stop
      </el-button>
      <el-button
        v-else
        type="primary"
        size="small"
        round
        class="send-btn"
        :disabled="!canSend"
        @click="handleSend"
      >
        <SendHorizontal class="w-4 h-4 mr-1" />
        Send
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Ban, SendHorizontal } from "lucide-vue-next";

const props = withDefaults(
  defineProps<{
    streaming?: boolean;
    placeholder?: string;
  }>(),
  { streaming: false, placeholder: "Type a message..." }
);

const emit = defineEmits<{
  send: [content: string];
  stop: [];
}>();

const inputText = ref("");

const canSend = computed(() => inputText.value.trim().length > 0);

function handleSend() {
  if (props.streaming || !canSend.value) return;
  const trimmed = inputText.value.trim();
  if (!trimmed) return;
  emit("send", trimmed);
  inputText.value = "";
}
</script>

<style scoped>
.chat-input-container {
  @apply flex flex-col gap-2 p-4 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900;
  max-height: 300px;
}

.chat-textarea {
  @apply resize-none;
}

.chat-textarea :deep(.el-textarea__inner) {
  @apply bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700
         text-gray-900 dark:text-gray-100 rounded-xl
         placeholder:text-gray-400 dark:placeholder:text-gray-500
         text-sm leading-relaxed;
  max-height: 200px;
  overflow-y: auto;
}

.chat-input-actions {
  @apply flex justify-end items-center gap-2;
  flex-shrink: 0;
}

.send-btn,
.stop-btn {
  @apply flex items-center;
}
</style>
