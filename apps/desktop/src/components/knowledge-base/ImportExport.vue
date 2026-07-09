<script setup lang="ts">
import { ref } from "vue";
import { Download, Upload } from "lucide-vue-next";
import { ElMessage } from "element-plus";
import * as tauriBridge from "@/services/tauriBridge";
import { useKBStore } from "@/stores/kbStore";

const store = useKBStore();
const importing = ref(false);
const exporting = ref(false);

async function handleImport() {
  let selected: string | null = null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    selected = await open({
      multiple: false,
      filters: [{ name: "Archive", extensions: ["zip"] }],
    });
  } catch {
    // Fallback: prompt user to enter path
    selected = prompt("Enter the path to the .zip file:") ?? null;
  }
  if (!selected) return;

  importing.value = true;
  try {
    const count = await tauriBridge.importKBs(selected);
    ElMessage.success(`Imported ${count} knowledge base(s)`);
    await store.loadKBs();
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    importing.value = false;
  }
}

async function handleExport() {
  const selectedIds = prompt(
    "Enter KB IDs to export (comma-separated), or leave empty for all:"
  );
  const kbs = store.knowledgeBases;
  const ids = selectedIds
    ? selectedIds.split(",").map((s) => s.trim()).filter(Boolean)
    : kbs.map((k) => k.id);

  if (ids.length === 0) {
    ElMessage.warning("No knowledge bases to export");
    return;
  }

  let outputPath: string | null = null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    outputPath = await save({
      filters: [{ name: "Archive", extensions: ["zip"] }],
      defaultPath: "knowledge-bases-export.zip",
    });
  } catch {
    outputPath = prompt("Enter the output path for the .zip file:") ?? null;
  }
  if (!outputPath) return;

  exporting.value = true;
  try {
    const result = await tauriBridge.exportKBs(ids, outputPath);
    ElMessage.success(`Exported to ${result}`);
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="import-export">
    <el-button size="small" :loading="importing" @click="handleImport">
      <Upload :size="14" style="margin-right: 4px" />
      Import
    </el-button>
    <el-button size="small" :loading="exporting" @click="handleExport">
      <Download :size="14" style="margin-right: 4px" />
      Export
    </el-button>
  </div>
</template>

<style scoped>
.import-export {
  display: flex;
  gap: 8px;
}
</style>
