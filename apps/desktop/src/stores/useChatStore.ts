import { create } from "zustand";
import type { ChatMessage, SearchResult } from "../types";

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  streaming: boolean;

  newConversation: () => string;
  setActiveConversation: (id: string) => void;
  addMessage: (convId: string, msg: ChatMessage) => void;
  updateLastAssistant: (convId: string, content: string, sources?: SearchResult[]) => void;
  deleteConversation: (id: string) => void;
  clearAll: () => void;
  renameConversation: (id: string, title: string) => void;
}

function loadConversations(): Conversation[] {
  try {
    const data = localStorage.getItem("chatConversations");
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveConversations(convs: Conversation[]) {
  localStorage.setItem("chatConversations", JSON.stringify(convs));
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: loadConversations(),
  activeConversationId: null,
  streaming: false,

  newConversation: () => {
    const id = crypto.randomUUID();
    const conv: Conversation = {
      id,
      title: "",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const conversations = [conv, ...get().conversations];
    saveConversations(conversations);
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
        // Auto-title from first user message
        title: c.title || (msg.role === "user" ? msg.content.slice(0, 40) : ""),
      };
      return updated;
    });
    saveConversations(conversations);
    set({ conversations });
  },

  updateLastAssistant: (convId, content, sources?) => {
    const conversations = get().conversations.map((c) => {
      if (c.id !== convId) return c;
      const messages = [...c.messages];
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        messages[messages.length - 1] = { ...messages[messages.length - 1], content, sources };
      }
      return { ...c, messages, updatedAt: new Date().toISOString() };
    });
    saveConversations(conversations);
    set({ conversations });
  },

  deleteConversation: (id) => {
    const conversations = get().conversations.filter((c) => c.id !== id);
    saveConversations(conversations);
    set({
      conversations,
      activeConversationId: get().activeConversationId === id ? null : get().activeConversationId,
    });
  },

  clearAll: () => {
    saveConversations([]);
    set({ conversations: [], activeConversationId: null });
  },

  renameConversation: (id, title) => {
    const conversations = get().conversations.map((c) =>
      c.id === id ? { ...c, title } : c
    );
    saveConversations(conversations);
    set({ conversations });
  },
}));
