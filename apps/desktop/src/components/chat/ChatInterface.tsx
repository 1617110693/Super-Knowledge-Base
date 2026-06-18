import { useState, useRef, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useChatStore } from "../../stores/useChatStore";
import { chatStream } from "../../services/pythonClient";
import {
  Send,
  Loader2,
  Bot,
  User,
  FileText,
  Trash2,
} from "lucide-react";
import type { SearchResult } from "../../types";

export function ChatInterface() {
  const { kbId } = useParams<{ kbId: string }>();
  const {
    messages,
    streaming,
    streamContent,
    addMessage,
    clearChat,
    setStreaming,
    appendStreamContent,
    resetStream,
  } = useChatStore();
  const [input, setInput] = useState("");
  const [sources, setSources] = useState<SearchResult[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const chatMessages = kbId ? messages[kbId] || [] : [];

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [chatMessages, streamContent]);

  const handleSend = async () => {
    if (!input.trim() || !kbId || streaming) return;
    const question = input.trim();
    setInput("");
    setSources([]);

    addMessage(kbId, { role: "user", content: question });
    setStreaming(true);
    resetStream();

    const assistantMsg: typeof chatMessages[0] = {
      role: "assistant",
      content: "",
    };

    await chatStream(
      {
        kb_id: kbId,
        question,
        top_k: 5,
        rerank: true,
        include_sources: true,
        chat_history: chatMessages.slice(-10).map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: true,
      },
      (token) => {
        appendStreamContent(token);
      },
      (srcs) => {
        setSources(srcs);
      },
      () => {
        // Done
        const content = useChatStore.getState().streamContent;
        if (content) {
          addMessage(kbId, {
            role: "assistant",
            content,
            sources,
          });
        }
        resetStream();
        setStreaming(false);
      },
      (err) => {
        addMessage(kbId, {
          role: "assistant",
          content: `Error: ${err}`,
        });
        resetStream();
        setStreaming(false);
      }
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b bg-card shrink-0">
        <h2 className="text-lg font-bold">RAG Chat</h2>
        <button
          onClick={() => kbId && clearChat(kbId)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-red-500"
        >
          <Trash2 className="w-3 h-3" />
          Clear
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
        {chatMessages.length === 0 && !streaming && (
          <div className="text-center py-16">
            <Bot className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">
              Ask questions about your documents
            </p>
          </div>
        )}

        {chatMessages.map((msg, i) => (
          <div
            key={i}
            className={`flex gap-3 ${
              msg.role === "user" ? "justify-end" : ""
            }`}
          >
            {msg.role === "assistant" && (
              <Bot className="w-6 h-6 text-primary shrink-0 mt-1" />
            )}
            <div
              className={`max-w-[80%] rounded-lg p-3 text-sm ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-card border"
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border">
                  <p className="text-xs text-muted-foreground mb-1">
                    Sources:
                  </p>
                  {msg.sources.map((s) => (
                    <div
                      key={s.chunk_id}
                      className="text-xs text-muted-foreground flex items-center gap-1"
                    >
                      <FileText className="w-3 h-3" />
                      {s.doc_name} ({(s.score * 100).toFixed(0)}%)
                    </div>
                  ))}
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <User className="w-6 h-6 text-muted-foreground shrink-0 mt-1" />
            )}
          </div>
        ))}

        {/* Streaming response */}
        {streaming && streamContent && (
          <div className="flex gap-3">
            <Bot className="w-6 h-6 text-primary shrink-0 mt-1" />
            <div className="max-w-[80%] rounded-lg p-3 text-sm bg-card border">
              <p className="whitespace-pre-wrap">{streamContent}</p>
              <Loader2 className="w-3 h-3 animate-spin inline ml-1" />
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-4 border-t bg-card shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Ask a question about your documents..."
            className="flex-1 px-4 py-2.5 border rounded-lg text-sm bg-background"
            disabled={streaming}
          />
          <button
            onClick={handleSend}
            disabled={streaming || !input.trim()}
            className="px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50"
          >
            {streaming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
