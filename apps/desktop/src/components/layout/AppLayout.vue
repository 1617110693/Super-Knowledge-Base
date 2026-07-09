<template>
  <div class="app-shell">
    <TitleBar>
      <template #center>
        <TabBar />
      </template>
    </TitleBar>
    <div class="app-body">
      <Sidebar />
      <main class="app-main">
        <router-view />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import TitleBar from "./TitleBar.vue";
import Sidebar from "./Sidebar.vue";
import TabBar from "./TabBar.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useChatStore } from "@/stores/chatStore";
import { useKBStore } from "@/stores/kbStore";

const settingsStore = useSettingsStore();
const chatStore = useChatStore();
const kbStore = useKBStore();

onMounted(async () => {
  try {
    await settingsStore.loadSettings();
  } catch {
    // Settings may fail gracefully if not configured yet
  }
  try {
    await chatStore.load();
  } catch {
    // Chat history may be empty
  }
  try {
    await kbStore.loadKBs();
  } catch {
    // KBs may not be available yet
  }
});
</script>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
}

.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.app-main {
  flex: 1;
  overflow: auto;
  background: var(--bg-primary);
  min-width: 0;
}
</style>
