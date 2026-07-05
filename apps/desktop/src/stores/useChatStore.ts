import { create } from "zustand";
import type { ChatMessage, ChatSettings, SearchResult, ToolCall } from "../types";
import { loadChatConversations, saveChatConversations } from "../services/tauriBridge";

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  chatSettings: ChatSettings;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  streaming: boolean;
  loaded: boolean;

  load: () => Promise<void>;
  newConversation: () => string;
  setActiveConversation: (id: string) => void;
  addMessage: (convId: string, msg: ChatMessage) => void;
  updateLastAssistant: (convId: string, content: string, sources?: SearchResult[], reasoning?: string) => void;
  updateLastAssistantWithToolCalls: (convId: string, content: string, toolCalls: ToolCall[], sources?: SearchResult[]) => void;
  deleteConversation: (id: string) => void;
  clearAll: () => void;
  renameConversation: (id: string, title: string) => void;
  updateChatSettings: (convId: string, settings: Partial<ChatSettings>) => void;
}

function persistConversations(convs: Conversation[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveChatConversations(convs as any).catch(console.error);
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  streaming: false,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const convs = await loadChatConversations();
      set({ conversations: convs as any, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  newConversation: () => {
    const id = crypto.randomUUID();
    const conv: Conversation = {
      id,
      title: "",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chatSettings: { selectedKbIds: [], contextWindow: 1 },
    };
    const conversations = [conv, ...get().conversations];
    persistConversations(conversations);
    set({ conversations, activeConversationId: id });
    return id;
  },

  setActiveConversation: (id) => set({ activeConversationId: id }),

  addMessage: (convId, msg) => {
    const conversations = get().conversations.map((c) => {
      if (c.id !== convId) return c;
      const updated = {
        ...c,
        messages: [...c.messages, msg],
        updatedAt: new Date().toISOString(),
        title: c.title || (msg.role === "user" ? msg.content.slice(0, 40) : ""),
      };
      return updated;
    });
    persistConversations(conversations);
    set({ conversations });
  },

  updateLastAssistant: (convId, content, sources?, reasoning?) => {
    const conversations = get().conversations.map((c) => {
      if (c.id !== convId) return c;
      const messages = [...c.messages];
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        messages[messages.length - 1] = { ...messages[messages.length - 1], content, sources, reasoning };
      }
      return { ...c, messages, updatedAt: new Date().toISOString() };
    });
    persistConversations(conversations);
    set({ conversations });
  },

  updateLastAssistantWithToolCalls: (convId, content, toolCalls, sources?) => {
    const conversations = get().conversations.map((c) => {
      if (c.id !== convId) return c;
      const messages = [...c.messages];
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        messages[messages.length - 1] = {
          ...messages[messages.length - 1], content, tool_calls: toolCalls, sources,
        };
      }
      return { ...c, messages, updatedAt: new Date().toISOString() };
    });
    persistConversations(conversations);
    set({ conversations });
  },

  deleteConversation: (id) => {
    const conversations = get().conversations.filter((c) => c.id !== id);
    persistConversations(conversations);
    set({
      conversations,
      activeConversationId: get().activeConversationId === id ? null : get().activeConversationId,
    });
  },

  clearAll: () => {
    persistConversations([]);
    set({ conversations: [], activeConversationId: null });
  },

  renameConversation: (id, title) => {
    const conversations = get().conversations.map((c) =>
      c.id === id ? { ...c, title } : c
    );
    persistConversations(conversations);
    set({ conversations });
  },

  updateChatSettings: (convId, settings) => {
    const conversations = get().conversations.map((c) => {
      if (c.id !== convId) return c;
      return {
        ...c,
        chatSettings: { ...c.chatSettings, ...settings },
        updatedAt: new Date().toISOString(),
      };
    });
    persistConversations(conversations);
    set({ conversations });
  },
}));
