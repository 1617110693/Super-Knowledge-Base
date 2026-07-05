import { useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage, SearchResult } from "../../types";
import { MessageRow } from "./MessageRow";

interface ChatMessageListProps {
  messages: ChatMessage[];
  streaming: boolean;
  toolResults: Record<string, string>;
  activeToolId: string | null;
  setPreviewChunk: (s: SearchResult | null) => void;
  copiedMsgIdx: number | null;
  handleCopy: (c: string, i: number) => void;
  autoScroll: boolean;
  onToggleAutoScroll: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

export function ChatMessageList({
  messages, streaming, toolResults, activeToolId, setPreviewChunk,
  copiedMsgIdx, handleCopy, autoScroll, scrollRef,
}: ChatMessageListProps) {
  const visibleMessages = messages.filter((m) => m.role !== "tool");
  const prevLenRef = useRef(visibleMessages.length);
  const prevContentRef = useRef(messages[messages.length - 1]?.content);

  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 5,
  });

  // Auto-scroll to bottom during streaming or when autoScroll is true
  useEffect(() => {
    if (visibleMessages.length === 0) return;

    const lastMsg = messages[messages.length - 1];
    const contentChanged = lastMsg?.content !== prevContentRef.current;
    const lenChanged = visibleMessages.length !== prevLenRef.current;

    prevLenRef.current = visibleMessages.length;
    prevContentRef.current = lastMsg?.content;

    if (!lenChanged && !contentChanged) return;
    if (!autoScroll && !streaming) return;

    // Use double RAF to ensure virtualizer has measured new items
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(visibleMessages.length - 1, { align: "end" });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [visibleMessages.length, streaming, messages[messages.length - 1]?.content]);

  // Trigger initial scroll to bottom on mount
  useEffect(() => {
    if (visibleMessages.length > 1) {
      const raf = requestAnimationFrame(() => {
        virtualizer.scrollToIndex(visibleMessages.length - 1, { align: "end" });
      });
      return () => cancelAnimationFrame(raf);
    }
  }, []);

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: "100%",
        position: "relative",
      }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const msg = visibleMessages[virtualItem.index];
        const isLast = virtualItem.index === visibleMessages.length - 1;
        const isStreaming = streaming && isLast && msg.role === "assistant";

        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualItem.start}px)`,
            }}
            className="pb-4"
          >
            <MessageRow
              msg={msg}
              i={virtualItem.index}
              isStreaming={isStreaming}
              isLast={isLast}
              streaming={streaming}
              toolResults={toolResults}
              activeToolId={activeToolId}
              setPreviewChunk={setPreviewChunk}
              copiedMsgIdx={copiedMsgIdx}
              handleCopy={handleCopy}
            />
          </div>
        );
      })}
    </div>
  );
}
