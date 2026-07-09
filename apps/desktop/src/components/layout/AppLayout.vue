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
        <router-view v-slot="{ Component }">
          <Transition name="page-fade" mode="out-in">
            <component :is="Component" />
          </Transition>
        </router-view>
      </main>
    </div>
    <!-- Global Search Dialog (outside page Transition to avoid el-dialog Teleport conflicts) -->
    <GlobalSearchDialog ref="globalSearchRef" />
    <!-- User Guide Dialog (outside page Transition) -->
    <UserGuideDialog :visible="showGuide" @update:visible="showGuide = $event" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import TitleBar from "./TitleBar.vue";
import Sidebar from "./Sidebar.vue";
import TabBar from "./TabBar.vue";
import GlobalSearchDialog from "@/components/search/GlobalSearchDialog.vue";
import UserGuideDialog from "@/components/common/UserGuideDialog.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useChatStore } from "@/stores/chatStore";
import { useKBStore } from "@/stores/kbStore";

const settingsStore = useSettingsStore();
const chatStore = useChatStore();
const kbStore = useKBStore();

const globalSearchRef = ref<InstanceType<typeof GlobalSearchDialog> | null>(null);
const showGuide = ref(false);

function openGlobalSearch() {
  globalSearchRef.value?.open();
}

// Provide for child components
import { provide } from "vue";
provide("openGlobalSearch", openGlobalSearch);

onMounted(async () => {
  try {
    await settingsStore.loadSettings();
  } catch {
    // Settings may fail gracefully if not configured yet
  }

  // First-launch detection (AFTER loadSettings, so settings are actual values)
  const s = settingsStore.settings;
  const isFresh = !s.embedding_api_key && !s.mineru_token && !s.llm_api_key;
  if (isFresh && !s.has_seen_guide) {
    setTimeout(() => { showGuide.value = true; }, 600);
  }

  // Persist has_seen_guide when the user closes the guide dialog
  watch(() => showGuide.value, (val) => {
    if (!val) {
      settingsStore.saveSettings({ ...settingsStore.settings, has_seen_guide: true });
    }
  });
  // Auto-start Python backend if not running
  try {
    const running = await settingsStore.checkPythonStatus();
    if (!running) {
      await settingsStore.startPython();
    }
  } catch {
    // Backend start may fail if not installed yet
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

.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.page-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.page-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
