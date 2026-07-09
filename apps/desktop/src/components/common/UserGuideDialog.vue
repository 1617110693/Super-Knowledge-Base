<template>
  <el-dialog
    :model-value="visible"
    title="🎉 欢迎使用 Knowledge Base"
    width="560px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <div class="guide-content">
      <section class="guide-section">
        <h3>📚 创建知识库</h3>
        <p>点击侧边栏的 <strong>+</strong> 按钮，输入名称和描述即可创建一个新的知识库。每个知识库可以包含多个文档。</p>
      </section>

      <section class="guide-section">
        <h3>📄 上传文档</h3>
        <p>在知识库内点击 <strong>上传文档</strong>，支持 PDF、Word、Excel、Markdown 等常见格式。系统会自动解析并索引文档内容。</p>
      </section>

      <section class="guide-section">
        <h3>💬 对话检索</h3>
        <p>选中知识库后，直接在聊天输入框提问，系统会检索知识库中的相关内容并给出回答，支持追问和上下文对话。</p>
      </section>

      <section class="guide-section">
        <h3>⌨️ 快捷键</h3>
        <ul class="shortcut-list">
          <li><kbd>Ctrl</kbd> + <kbd>K</kbd> 全局搜索</li>
          <li><kbd>Ctrl</kbd> + <kbd>N</kbd> 新建知识库</li>
          <li><kbd>Ctrl</kbd> + <kbd>,</kbd> 打开设置</li>
          <li><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>U</kbd> 上传文档</li>
        </ul>
      </section>
    </div>
    <template #footer>
      <span class="dialog-footer">
        <el-button type="primary" @click="handleGotIt">知道了</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

function handleGotIt() {
  emit('update:visible', false)
}
</script>

<style scoped>
.guide-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.guide-section {
  line-height: 1.6;
}

.guide-section h3 {
  margin: 0 0 6px 0;
  font-size: 15px;
  font-weight: 600;
}

.guide-section p {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.shortcut-list {
  margin: 0;
  padding-left: 20px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.shortcut-list li {
  margin-bottom: 4px;
}

kbd {
  display: inline-block;
  padding: 1px 6px;
  font-size: 12px;
  font-family: inherit;
  background-color: var(--el-fill-color);
  border: 1px solid var(--el-border-color);
  border-radius: 3px;
  box-shadow: 0 1px 0 var(--el-border-color);
}
</style>
