import { useState, useRef, useEffect, memo } from "react";
import { Check, Copy, Loader2, ChevronDown, User, Bot } from "lucide-react";
import type { ChatMessage, SearchResult, ToolCall } from "../../types";
import { ChatMarkdown } from "./ChatMarkdown";
import { ToolCallCards } from "./ToolCallCards";

function ThinkingBlock({ reasoning, isStreaming }: { reasoning: string; isStreaming: boolean }) {
  const [open, setOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [reasoning]);

  useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  return (
    <div className="mb-2 border rounded-lg overflow-hidden bg-amber-50/30 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition-colors">
        {isStreaming ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />}
        💭 {isStreaming ? "Thinking..." : "Thought process"}
      </button>
      {open && (
        <div ref={scrollRef} className="max-h-48 overflow-y-auto px-3 py-2 border-t border-amber-200 dark:border-amber-800">
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words leading-relaxed">{reasoning}</div>
        </div>
      )}
    </div>
  );
}

interface MessageRowProps {
  msg: ChatMessage;
  i: number;
  isStreaming: boolean;
  isLast: boolean;
  streaming: boolean;
  toolResults: Record<string, string>;
  activeToolId: string | null;
  setPreviewChunk: (s: SearchResult | null) => void;
  copiedMsgIdx: number | null;
  handleCopy: (c: string, i: number) => void;
}

export const MessageRow = memo(function MessageRow({
  msg, i, isStreaming, isLast, streaming,
  toolResults, activeToolId, setPreviewChunk,
  copiedMsgIdx, handleCopy,
}: MessageRowProps) {
  return (
    <div className={`flex gap-3 group ${msg.role === "user" ? "justify-end" : ""}`}>
      {msg.role === "assistant" && (
        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><Bot className="w-4 h-4 text-primary" /></div>
      )}
      <div className="relative max-w-[80%]">
        <div className={`rounded-xl px-4 py-2.5 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
          {/* Reasoning / thinking block */}
          {msg.role === "assistant" && msg.reasoning ? (
            <ThinkingBlock reasoning={msg.reasoning} isStreaming={isStreaming} />
          ) : null}
          {msg.role === "assistant" && msg.content ? (
            // Unified renderer: ChatMarkdown handles BOTH streaming (incremental
            // parse of incomplete markdown — real-time formatted output) and final
            // state. Replaces the old plain-text-during-streaming branch.
            <ChatMarkdown
              className="prose prose-sm max-w-none dark:prose-invert text-sm"
              isStreaming={isStreaming}
              sources={msg.sources}
              onSourceClick={(s) => setPreviewChunk(s as SearchResult)}
            >
              {msg.content}
            </ChatMarkdown>
          ) : msg.role === "assistant" && msg.tool_calls && !msg.content ? (
            <ToolCallCards toolCalls={msg.tool_calls} toolResults={toolResults} activeToolId={activeToolId} />
          ) : msg.role === "assistant" && streaming && isLast ? (
            <Loader2 className="w-3 h-3 animate-spin inline" />
          ) : (
            <div className="whitespace-pre-wrap break-words">{msg.content}</div>
          )}
        </div>
        {msg.content && (
          <button
            onClick={() => handleCopy(msg.content, i)}
            className={`absolute ${msg.role === "user" ? "-left-8 bottom-1" : "-right-8 bottom-1"} hidden group-hover:flex p-1 rounded hover:bg-muted text-muted-foreground transition-colors`}
            title="Copy"
          >
            {copiedMsgIdx === i ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
      {msg.role === "user" && (
        <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5"><User className="w-4 h-4 text-primary-foreground" /></div>
      )}
    </div>
  );
}, (prev, next) => {
  // Skip re-render unless something the row actually depends on changed.
  // During streaming only the last row's `msg.content` grows; all other rows
  // keep the same `msg` reference (store maps messages immutably except the
  // last), so they skip re-rendering entirely.
  return (
    prev.msg === next.msg &&
    prev.isStreaming === next.isStreaming &&
    prev.streaming === next.streaming &&
    prev.toolResults === next.toolResults &&
    prev.activeToolId === next.activeToolId &&
    prev.copiedMsgIdx === next.copiedMsgIdx &&
    prev.handleCopy === next.handleCopy &&
    prev.setPreviewChunk === next.setPreviewChunk
  );
});
