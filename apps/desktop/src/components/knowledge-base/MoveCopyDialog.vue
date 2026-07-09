<script setup lang="ts">
import { ref, computed } from "vue";
import { useKBStore } from "@/stores/kbStore";
import { ArrowRight, Copy, Move } from "lucide-vue-next";
import { ElMessage } from "element-plus";
import * as tauriBridge from "@/services/tauriBridge";

const props = defineProps<{
  visible: boolean;
  kbId: string;
  docId: string;
  docName: string;
  action: "move" | "copy";
}>();

const emit = defineEmits<{
  (e: "update:visible", val: boolean): void;
  (e: "done"): void;
}>();

const store = useKBStore();
const targetKbId = ref("");
const submitting = ref(false);

const otherKBs = computed(() =>
  store.knowledgeBases.filter((k) => k.id !== props.kbId)
);

async function handleSubmit() {
  if (!targetKbId.value) return;
  submitting.value = true;
  try {
    if (props.action === "copy") {
      await tauriBridge.copyDocumentToKb(props.kbId, props.docId, targetKbId.value, null);
      ElMessage.success(`Document copied`);
    }
    // Move is not supported via Tauri bridge yet; placeholder for future
    emit("done");
    emit("update:visible", false);
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="action === 'copy' ? 'Copy Document' : 'Move Document'"
    width="400px"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
    @open="targetKbId = ''"
  >
    <div class="move-copy-content">
      <div class="doc-info">
        <template v-if="action === 'copy'">
          <Copy :size="16" />
        </template>
        <template v-else>
          <Move :size="16" />
        </template>
        <span class="doc-name">{{ docName }}</span>
      </div>
      <ArrowRight :size="16" class="arrow-icon" />
      <el-select
        v-model="targetKbId"
        placeholder="Select target knowledge base"
        style="width: 100%"
      >
        <el-option
          v-for="kb in otherKBs"
          :key="kb.id"
          :label="kb.name"
          :value="kb.id"
        />
      </el-select>
    </div>
    <template #footer>
      <el-button @click="emit('update:visible', false)">Cancel</el-button>
      <el-button
        type="primary"
        :disabled="!targetKbId"
        :loading="submitting"
        @click="handleSubmit"
      >
        {{ action === "copy" ? "Copy" : "Move" }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.move-copy-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.doc-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--surface-raised);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
}

.doc-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arrow-icon {
  align-self: center;
  color: var(--text-secondary);
}
</style>
