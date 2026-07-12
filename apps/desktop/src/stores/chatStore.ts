import { defineStore } from "pinia";
import { ref } from "vue";
import type { ChatMessage, ChatSettings, SearchResult, ToolCall, WebSearchSource } from "@/types";
import { loadChatConversations, saveChatConversations } from "@/services/tauriBridge";

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  chatSettings: ChatSettings;
}

export const useChatStore = defineStore("chat", () => {
  const conversations = ref<Conversation[]>([]);
  const activeConversationId = ref<string | null>(null);
  const streaming = ref(false);
  const streamingConvId = ref<string | null>(null);
  const loaded = ref(false);

  async function load() {
    if (loaded.value) return;
    try {
      const convs = await loadChatConversations();
      conversations.value = (convs as any) || [];
      loaded.value = true;
    } catch {
      loaded.value = true;
    }
  }

  function newConversation(): string {
    const id = crypto.randomUUID();
    const conv: Conversation = {
      id, title: "", messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chatSettings: { selectedKbIds: [], contextWindow: 1 },
    };
    conversations.value = [conv, ...conversations.value];
    persistConversations();
    activeConversationId.value = id;
    return id;
  }

  function setActiveConversation(id: string) { activeConversationId.value = id; }

  function addMessage(convId: string, msg: ChatMessage) {
    conversations.value = conversations.value.map((c) => {
      if (c.id !== convId) return c;
      return {
        ...c, messages: [...c.messages, msg],
        updatedAt: new Date().toISOString(),
        title: c.title || (msg.role === "user" ? msg.content.slice(0, 40) : ""),
      };
    });
    if (streamingConvId.value !== convId) persistConversations();
  }

  function updateLastAssistant(convId: string, content: string, sources?: SearchResult[], reasoning?: string, webSources?: WebSearchSource[]) {
    conversations.value = conversations.value.map((c) => {
      if (c.id !== convId) return c;
      const messages = [...c.messages];
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        messages[messages.length - 1] = { ...messages[messages.length - 1], content, sources, reasoning, webSources };
      }
      return { ...c, messages, updatedAt: new Date().toISOString() };
    });
    if (streamingConvId.value !== convId) persistConversations();
  }

  function updateLastAssistantWithToolCalls(convId: string, content: string, toolCalls: ToolCall[], sources?: SearchResult[], webSources?: WebSearchSource[]) {
    conversations.value = conversations.value.map((c) => {
      if (c.id !== convId) return c;
      const messages = [...c.messages];
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        messages[messages.length - 1] = { ...messages[messages.length - 1], content, tool_calls: toolCalls, sources, webSources };
      }
      return { ...c, messages, updatedAt: new Date().toISOString() };
    });
    if (streamingConvId.value !== convId) persistConversations();
  }

  function setStreamingConv(id: string | null) { streamingConvId.value = id; }
  function persistConversation(_convId: string) { persistConversations(); }

  function deleteConversation(id: string) {
    conversations.value = conversations.value.filter((c) => c.id !== id);
    if (activeConversationId.value === id) activeConversationId.value = null;
    persistConversations();
  }

  function clearAll() {
    conversations.value = [];
    activeConversationId.value = null;
    persistConversations([]);
  }

  function renameConversation(id: string, title: string) {
    conversations.value = conversations.value.map((c) => c.id === id ? { ...c, title } : c);
    persistConversations();
  }

  function updateChatSettings(convId: string, settings: Partial<ChatSettings>) {
    conversations.value = conversations.value.map((c) =>
      c.id !== convId ? c : { ...c, chatSettings: { ...c.chatSettings, ...settings }, updatedAt: new Date().toISOString() }
    );
    persistConversations();
  }

  function persistConversations(convs?: Conversation[]) {
    saveChatConversations((convs ?? conversations.value) as any).catch(console.error);
  }

  return {
    conversations, activeConversationId, streaming, streamingConvId, loaded,
    load, newConversation, setActiveConversation, addMessage, updateLastAssistant,
    updateLastAssistantWithToolCalls, setStreamingConv, persistConversation,
    deleteConversation, clearAll, renameConversation, updateChatSettings,
  };
});
