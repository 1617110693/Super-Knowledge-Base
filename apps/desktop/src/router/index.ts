import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      component: () => import("@/components/layout/AppLayout.vue"),
      children: [
        {
          path: "",
          name: "dashboard",
          component: () => import("@/components/knowledge-base/KBDashboard.vue"),
        },
        {
          path: "kb/:kbId",
          name: "kb-settings",
          component: () => import("@/components/knowledge-base/KBSettings.vue"),
        },
        {
          path: "kb/:kbId/documents/:docId",
          name: "document-preview",
          component: () => import("@/components/documents/DocumentPreview.vue"),
        },
        {
          path: "kb/:kbId/search",
          name: "kb-search",
          component: () => import("@/components/search/SearchInterface.vue"),
        },
        {
          path: "chat/:convId",
          name: "chat-conversation",
          component: () => import("@/components/chat/ChatPage.vue"),
        },
        {
          path: "chat",
          name: "chat-new",
          component: () => import("@/components/chat/ChatPage.vue"),
        },
        {
          path: "settings",
          name: "settings",
          component: () => import("@/components/settings/SettingsPanel.vue"),
        },
      ],
    },
  ],
});

export default router;
