import { create } from "zustand";
import type { ChatMessage, SearchResult } from "../types";

interface ChatState {
  messages: Record<string, ChatMessage[]>; // keyed by kbId
  streaming: boolean;
  streamContent: string;

  addMessage: (kbId: string, msg: ChatMessage) => void;
  clearChat: (kbId: string) => void;
  setStreaming: (v: boolean) => void;
  appendStreamContent: (token: string) => void;
  resetStream: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: {},
  streaming: false,
  streamContent: "",

  addMessage: (kbId, msg) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [kbId]: [...(s.messages[kbId] || []), msg],
      },
    })),

  clearChat: (kbId) =>
    set((s) => ({
      messages: { ...s.messages, [kbId]: [] },
    })),

  setStreaming: (v) => set({ streaming: v }),

  appendStreamContent: (token) =>
    set((s) => ({ streamContent: s.streamContent + token })),

  resetStream: () => set({ streamContent: "", streaming: false }),
}));
