import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useChatStore } from "../../stores/useChatStore";
import { useTabStore } from "../../stores/useTabStore";
import { useKBStore } from "../../stores/useKBStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useI18n } from "../../i18n";
import { CHAT_TOOLS, toolLabel } from "../../services/toolDefinitions";
import { executeToolCall } from "../../services/toolExecutor";
import { Loader2, Trash2, MessageSquare, User, RefreshCw, ArrowDown, ArrowDownToLine, Plus } from "lucide-react";
import { ChatMessageList } from "./ChatMessageList";
import { ChatInput } from "./ChatInput";
import { KBSelector, KBSelectedTags } from "./KBSelector";
import { SourcesPanel } from "./SourcesPanel";
import { ChunkDetailDialog } from "../common/ChunkDetailDialog";
import { getChunkByIndex, getChunkRange } from "../../services/pythonClient";
import { listDocuments } from "../../services/tauriBridge";
import { loadMemoryGraph, formatMemoryForPrompt } from "../../services/memoryStore";
import type { ChatMessage, SearchResult, ToolCall } from "../../types";

/** Normalize LaTeX math delimiters so remark-math can process them. */
function normalizeMath(text: string): string {
  text = text.replace(/\\\((.+?)\\\)/gs, (_, m) => `$${m}$`);
  text = text.replace(/\\\[(.+?)\\\]/gs, (_, m) => `$$\n${m}\n$$`);
  text = text.replace(/\$\$\$\$/g, "$$");
  return text;
}

export function ChatPage() {
  const { convId } = useParams<{ convId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { settings } = useSettingsStore();
  const { knowledgeBases, loadKBs } = useKBStore();
  const {
    conversations, activeConversationId,
    newConversation, addMessage, updateLastAssistant, updateLastAssistantWithToolCalls,
    deleteConversation, setActiveConversation, updateChatSettings,
    setStreamingConv, persistConversation,
  } = useChatStore();

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [showKbDropdown, setShowKbDropdown] = useState(false);
  const [previewChunk, setPreviewChunk] = useState<SearchResult | null>(null);
  const [toolStatus, setToolStatus] = useState("");
  const [toolResults, setToolResults] = useState<Record<string, string>>({});
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [manualExpand, setManualExpand] = useState<Set<string>>(new Set());
  const [copiedMsgIdx, setCopiedMsgIdx] = useState<number | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadKBs(); loadMemoryGraph().catch(() => {}); }, []);

  const conv = conversations.find((c) => c.id === (convId || activeConversationId));
  const messages = conv?.messages || [];
  const selectedKbIds: string[] = conv?.chatSettings?.selectedKbIds ?? [];
  const contextWindow: number = conv?.chatSettings?.contextWindow ?? 1;

  // Collect all sources from the most recent assistant message
  const lastAssistantSources = [...messages].reverse().find((m) => m.role === "assistant")?.sources || [];

  useEffect(() => {
    if (convId) setActiveConversation(convId);
    if (!convId && !activeConversationId) {
      const id = newConversation();
      navigate(`/chat/${id}`, { replace: true });
    }
  }, [convId]);

  // Browser tab title — mirrors the sidebar conversation label.
  // New conversations show "新对话" until the first user message gives them a
  // title; the title stays in sync as the sidebar renames the conversation.
  useEffect(() => {
    const title = conv?.title || conv?.messages?.[0]?.content?.slice(0, 30) || t("chat.new");
    document.title = `${title} — SKB`;
  }, [convId, conv?.title, conv?.messages?.[0]?.content]);

  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    // During streaming, always use instant scroll — smooth causes jitter
    const behavior = (smooth && !streaming) ? "smooth" : "instant";
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior });
    });
  };

  useEffect(() => {
    if (autoScroll) scrollToBottom();
  }, [messages, toolStatus, autoScroll]);

  // Track scroll position: pause auto-scroll when user scrolls up, resume when
  // they scroll back to the very bottom (within 4px tolerance).
  // Also save scroll position to tab store for persistence across tab switches.
  const lastScrollSave = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(dist > 200);
      if (dist < 4) {
        setAutoScroll(true);
      } else if (dist > 20) {
        setAutoScroll(false);
      }
      // Save scroll position to tab store (throttled to 500ms)
      const now = Date.now();
      if (now - lastScrollSave.current > 500 && conv) {
        lastScrollSave.current = now;
        const tab = useTabStore.getState().tabs.find((t) => t.type === "chat" && t.convId === conv.id);
        if (tab) {
          useTabStore.getState().saveTabState(tab.id, { scrollTop: el.scrollTop });
        }
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    // Restore scroll position on mount
    const tab = useTabStore.getState().tabs.find((t) => t.type === "chat" && t.convId === conv?.id);
    if (tab && tab.scrollTop > 0) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.scrollTop = tab.scrollTop;
        });
      });
    }

    return () => el.removeEventListener("scroll", onScroll);
  }, [conv?.id]);

  const handleSend = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || streaming) return;
    const currentConv = conversations.find((c) => c.id === (convId || activeConversationId));
    if (!currentConv) return;

    const userMsg = { role: "user" as const, content: msg };
    addMessage(currentConv.id, userMsg);
    setInput("");
    setError("");
    setAutoScroll(true);
    setStreaming(true);
    // Mark this conv as streaming — store writes skip disk I/O until cleared,
    // so the 80ms token-flush loop doesn't trigger dozens of disk writes.
    setStreamingConv(currentConv.id);

    // Add placeholder assistant message
    addMessage(currentConv.id, { role: "assistant" as const, content: "" });

    try {
      const apiBase = (settings.llm_api_base || "https://api.openai.com/v1").replace(/\/$/, "");
      const apiKey = settings.llm_api_key || "";
      const model = settings.llm_model || "gpt-4o-mini";

      if (!apiKey) {
        updateLastAssistant(currentConv.id, t("chat.noApiKey"));
        setStreaming(false);
        return;
      }

      const mathInstr = "Wrap ALL math in $..$ or $$..$$. Single symbols too: $x$, $\\alpha$, $A$. Display equations: $$A^T A$$. No bare LaTeX.";
      const citeInstr = "IMPORTANT: Each search result has an 'index' field (1,2,3...) AND a 'chunk_index' field (document position). Use the INDEX number for citation: write [N] where N is the result index, NOT the chunk_index. Example: if result index=1 has chunk_index=8, cite it as [1], not [8].";
      const imageInstr = "IMPORTANT — IMAGE REFERENCES: When your search results include content_type='image' chunks, ALWAYS include the image in your response using markdown: ![description](images/filename.jpg). Extract the exact filename from the chunk content (look for 'Image: hash.jpg' or 'images/hash.jpg'). The image will render inline as a clickable thumbnail for the user. Never skip images — they are key visual information that supplements your text answer.";
      const webSearchEnabled = conv?.chatSettings?.webSearchEnabled ?? false;
      const webInstr = `WEB SEARCH (ENABLED): You MUST call web_search before answering whenever the question involves (a) recent events, news, or dates after your training cutoff, (b) real-time or live information, (c) specific facts you are not confident about, or (d) anything beyond the selected knowledge bases. Do NOT answer from memory alone if web_search could give a fresher or more accurate answer. After web_search, use web_fetch to read a specific result page if you need full detail. Cite web results by URL or title so the user knows the source.`;
      const kbNames = selectedKbIds.length > 0
        ? selectedKbIds.map((id) => knowledgeBases.find((kb) => kb.id === id)?.name || id).join(", ")
        : "";
      const ragInstr = kbNames ? `You have access to knowledge bases: ${kbNames}.

HOW TO ANSWER QUESTIONS (RAG-first workflow):
1. Use search_knowledge_base to find the most relevant chunks across all KBs. This is your PRIMARY tool for answering questions — it returns precise, pre-chunked content.
2. If you need more context around a result, use get_chunk_by_index with neighboring chunk_index values, or search_knowledge_base with context_window > 0.
3. DO NOT use get_document or get_document_chunks to answer questions — documents can be hundreds of pages and will overflow context. These tools are for browsing/document management, not Q&A.
4. get_document_summary gives you a document's structure (headings, chunk count) without loading content — use it to understand what a document covers.` : "";
      let systemMsg = kbNames
        ? `${ragInstr}\n\n${citeInstr}\n\n${imageInstr}`
        : "You are a helpful assistant.";
      if (webSearchEnabled) systemMsg += `\n\n${webInstr}`;
      // Inject memory context
      const memoryPrompt = formatMemoryForPrompt(2000);
      if (memoryPrompt) systemMsg += `\n\n${memoryPrompt}`;
      systemMsg += `\n\n${mathInstr}`;

      // Build conversation history including tool messages
      const rawHistory = ([...currentConv.messages, userMsg] as ChatMessage[])
        .filter((m) => m.content || m.tool_calls)
        .slice(-(settings.max_history_messages || 80));

      const messages: Array<Record<string, unknown>> = [
        { role: "system", content: systemMsg },
        ...rawHistory.map((m) => {
          const out: Record<string, unknown> = { role: m.role };
          if (m.content) out.content = m.content;
          else out.content = null;
          if (m.tool_calls) out.tool_calls = m.tool_calls.map((tc: ToolCall) => ({
            id: tc.id, type: "function", function: tc.function,
          }));
          if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
          if (m.name) out.name = m.name;
          return out;
        }),
      ];

      // ── Tool-calling loop ──
      let allSources: SearchResult[] = [];
      const kbList = knowledgeBases; // snapshot at send time

      for (let round = 0; round < (settings.max_tool_rounds || 10); round++) {
        // Filter tools: exclude web search when disabled, exclude KB tools when no KB selected
        const noKb = selectedKbIds.length === 0;
        let activeTools = CHAT_TOOLS;
        if (!webSearchEnabled) activeTools = activeTools.filter((t) => t.function.name !== "web_search" && t.function.name !== "web_fetch");
        if (noKb) activeTools = activeTools.filter((t) => !["search_knowledge_base", "get_document", "get_document_chunks", "list_documents", "get_chunk_by_index", "get_chunks_by_page", "list_knowledge_bases"].includes(t.function.name));
        const resp = await fetch(`${apiBase}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, tools: activeTools, tool_choice: "auto", stream: true }),
        });

        if (!resp.ok) { const err = await resp.text(); throw new Error(err); }

        const reader = resp.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();

        let fullContent = "";
        let fullReasoning = "";
        const toolCallsAcc = new Map<number, { id: string; name: string; arguments: string }>();
        let finishReason = "";

        // Throttled store updates during streaming
        let lastFlush = 0;
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const flushContent = () => {
          updateLastAssistant(currentConv.id, fullContent, allSources, fullReasoning);
          lastFlush = Date.now();
          flushTimer = null;
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              const choice = json.choices?.[0];
              const delta = choice?.delta;
              finishReason = choice?.finish_reason || finishReason;

              if (delta?.reasoning_content) {
                fullReasoning += delta.reasoning_content;
              }
              if (delta?.content) {
                fullContent += delta.content;
              }
              // Throttle store updates for BOTH content and reasoning — pushes
              // every 80ms. Previously reasoning updated immediately per-token,
                // causing ~50 store updates/sec + matching disk writes for
                // reasoning models.
              if (delta?.content || delta?.reasoning_content) {
                const now = Date.now();
                if (now - lastFlush >= 80 && !flushTimer) {
                  flushContent();
                } else if (!flushTimer) {
                  flushTimer = setTimeout(flushContent, 80 - (now - lastFlush));
                }
              }
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsAcc.has(idx)) {
                    toolCallsAcc.set(idx, { id: tc.id || "", name: "", arguments: "" });
                  }
                  const entry = toolCallsAcc.get(idx)!;
                  if (tc.id) entry.id = tc.id;
                  if (tc.function?.name) entry.name += tc.function.name;
                  if (tc.function?.arguments) entry.arguments += tc.function.arguments;
                }
              }
            } catch { /* ignore malformed JSON in stream */ }
          }
        }

        // No tool calls — final answer
        if (finishReason === "stop" && toolCallsAcc.size === 0) {
          if (flushTimer) clearTimeout(flushTimer);
          fullContent = normalizeMath(fullContent);
          updateLastAssistant(currentConv.id, fullContent, allSources, fullReasoning);
          break;
        }

        // Tool calls requested — execute them
        if (toolCallsAcc.size > 0) {
          const tcArray: ToolCall[] = Array.from(toolCallsAcc.values()).map((tc) => ({
            id: tc.id,
            function: { name: tc.name, arguments: tc.arguments },
          }));

          // Save assistant message with tool_calls
          updateLastAssistantWithToolCalls(currentConv.id, fullContent, tcArray, allSources);

          // Append assistant message (with tool_calls) to the LLM message list
          messages.push({
            role: "assistant",
            content: fullContent || null,
            tool_calls: tcArray.map((tc) => ({
              id: tc.id, type: "function", function: tc.function,
            })),
          });

          // Execute each tool call
          for (const tc of tcArray) {
            setToolStatus(toolLabel(tc));
            setActiveToolId(tc.id);
            // Collapse all previously manual-expanded cards for new tool round
            setManualExpand(new Set());
            try {
              const { result, newSources } = await executeToolCall(tc, kbList, {
                maxSearchResultChars: settings.max_search_result_chars || 2000,
                maxDocumentChars: settings.max_document_chars || 30000,
                maxChunkChars: settings.max_chunk_chars || 800,
              }, selectedKbIds.length > 0 ? selectedKbIds : undefined, contextWindow, allSources.length);
              allSources = [...allSources, ...newSources];
              // Store tool result for UI display
              setToolResults(prev => ({ ...prev, [tc.id]: result.content }));
              messages.push({
                role: "tool",
                tool_call_id: result.tool_call_id,
                content: result.content,
                name: tc.function.name,
              });
              // Save tool result to conversation store for multi-turn history
              addMessage(currentConv.id, {
                role: "tool",
                content: result.content,
                tool_call_id: result.tool_call_id,
                name: tc.function.name,
              });
            } catch (toolErr) {
              const errContent = JSON.stringify({ error: String(toolErr) });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: errContent,
                name: tc.function.name,
              });
              addMessage(currentConv.id, {
                role: "tool",
                content: errContent,
                tool_call_id: tc.id,
                name: tc.function.name,
              });
            }
          }
          setToolStatus("");

          // New placeholder for the next LLM response
          addMessage(currentConv.id, { role: "assistant" as const, content: "" });
          fullContent = "";
        } else {
          break; // finish_reason=stop with no content (edge case)
        }
      } // end tool-calling loop

    } catch (e) {
      const errMsg = String(e);
      updateLastAssistant(currentConv.id, `Error: ${errMsg}`);
      setError(errMsg);
    }
    setStreaming(false);
    setToolStatus("");
    // Stream done — persist the conversation once. Only clear the streaming
    // flag if it still points at us; if the user has since started a new stream
    // in another conversation, that one owns the flag now and we must not
    // prematurely re-enable persistence for it.
    if (useChatStore.getState().streamingConvId === currentConv.id) {
      setStreamingConv(null);
    }
    persistConversation(currentConv.id);
  };

  const handleNew = () => { const id = newConversation(); navigate(`/chat/${id}`); };
  const handleDelete = () => {
    if (conv) { deleteConversation(conv.id); const id = newConversation(); navigate(`/chat/${id}`, { replace: true }); }
  };
  const handleStop = () => {
    abortCtrl?.abort();
    setAbortCtrl(null);
    setStreaming(false);
    setToolStatus("");
  };
  const handleCopy = useCallback(async (content: string, idx: number) => {
    await navigator.clipboard.writeText(content);
    setCopiedMsgIdx(idx);
    setTimeout(() => setCopiedMsgIdx(null), 2000);
  }, []);
  const handleRegenerate = async () => {
    if (!conv || streaming) return;
    const msgs = [...conv.messages];
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return;
    const lastUserContent = msgs[lastUserIdx].content;
    // Remove last assistant message(s) and tool results from store
    const trimmed = msgs.slice(0, lastUserIdx);
    useChatStore.setState((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conv.id) return c;
        return { ...c, messages: trimmed, updatedAt: new Date().toISOString() };
      }),
    }));
    handleSend(lastUserContent);
  };

  const toggleKb = (id: string) => {
    if (!conv) return;
    const next = selectedKbIds.includes(id)
      ? selectedKbIds.filter((x) => x !== id)
      : [...selectedKbIds, id];
    updateChatSettings(conv.id, { selectedKbIds: next });
  };

  if (!conv) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  const navigatePreviewChunk = (delta: number) => {
    const pc = previewChunk;
    if (pc == null || !pc.kb_id || !pc.doc_id) return;
    if (pc.metadata?.chunk_index == null) return;
    const ci = pc.metadata.chunk_index as number;
    const kb = pc.kb_id;
    const did = pc.doc_id;
    getChunkByIndex({ kb_id: kb, doc_id: did, chunk_index: ci + delta }).then(res => {
      if (!("error" in res)) {
        const c = res.chunk;
        setPreviewChunk({ ...pc,
          content: c.content, chunk_id: c.chunk_id,
          page_start: c.page_start, page_end: c.page_end,
          metadata: { ...pc.metadata, chunk_index: c.chunk_index,
            page: c.page_number, page_start: c.page_start, page_end: c.page_end },
        });
        return;
      }
      // Cross-part navigation for split documents
      listDocuments(kb).then(docs => {
        const curParent = (docs.find(d => d.id === did) as any)?.parent_doc_id;
        const siblings = docs
          .filter(d => d.id !== did)
          .filter(d => (curParent && (d as any).parent_doc_id === curParent) || (d as any).parent_doc_id === did)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!siblings.length) return;
        const curIdx = siblings.findIndex(d => d.name.localeCompare(pc.doc_name!) > 0);
        const target = delta > 0
          ? (curIdx >= 0 ? siblings[curIdx] : siblings[0])
          : (curIdx > 0 ? siblings[curIdx - 1] : siblings[siblings.length - 1]);
        if (!target) return;
        if (delta > 0) {
          getChunkByIndex({ kb_id: kb, doc_id: target.id, chunk_index: 0 }).then(r2 => {
            if ("error" in r2) return;
            const c2 = r2.chunk;
            setPreviewChunk({
              ...pc,
              content: c2.content, chunk_id: c2.chunk_id, doc_id: c2.doc_id,
              doc_name: c2.doc_name,
              page_start: c2.page_start, page_end: c2.page_end,
              metadata: { ...pc.metadata, chunk_index: c2.chunk_index,
                page: c2.page_number, page_start: c2.page_start, page_end: c2.page_end },
            });
          }).catch(() => {});
        } else {
          getChunkRange({ kb_id: kb, doc_id: target.id, start: 0, end: 100000 }).then(r2 => {
            const chunks = r2.chunks || [];
            if (!chunks.length) return;
            const last = chunks.reduce((a, b) => a.chunk_index > b.chunk_index ? a : b);
            setPreviewChunk({
              ...pc,
              content: last.content, chunk_id: last.chunk_id, doc_id: last.doc_id,
              doc_name: last.doc_name,
              page_start: last.page_start, page_end: last.page_end,
              metadata: { ...pc.metadata, chunk_index: last.chunk_index,
                page: last.page_number, page_start: last.page_start, page_end: last.page_end },
            });
          }).catch(() => {});
        }
      }).catch(() => {});
    }).catch(() => {});
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0 bg-card/50">
        <MessageSquare className="w-5 h-5 text-primary" />
        <h2 className="font-semibold text-sm truncate flex-1">{conv.title || t("chat.newConversation")}</h2>

        {/* Context window toggle */}
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title={t("chat.contextWindowHelp") || "Include neighboring chunks in search results for more context"}>
          <span className="hidden sm:inline">{t("chat.contextWindow") || "Ctx"}</span>
          <select value={contextWindow} onChange={(e) => { if (conv) updateChatSettings(conv.id, { contextWindow: Number(e.target.value) }); }} className="px-1.5 py-0.5 border rounded bg-background text-[11px]">
            <option value="0">±0</option>
            <option value="1">±1</option>
            <option value="2">±2</option>
          </select>
        </label>

        {/* Web search toggle — pill toggle with globe icon and clear state */}
        <button
          onClick={() => { if (conv) updateChatSettings(conv.id, { webSearchEnabled: !conv.chatSettings.webSearchEnabled }); }}
          className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all duration-200 select-none ${
            conv?.chatSettings?.webSearchEnabled
              ? "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800"
              : "bg-muted/60 text-muted-foreground border border-transparent hover:bg-muted hover:text-foreground/70"
          }`}
          title={t("chat.webSearch")}
        >
          <span className={`text-sm transition-transform ${conv?.chatSettings?.webSearchEnabled ? "" : "opacity-50"}`}>🌐</span>
          <span>{conv?.chatSettings?.webSearchEnabled ? t("chat.webSearchOn") : t("chat.webSearchOff")}</span>
        </button>

        {/* Multi-select KB dropdown */}
        <KBSelector
          knowledgeBases={knowledgeBases}
          selectedKbIds={selectedKbIds}
          onToggleKb={toggleKb}
          onClearAll={() => { if (conv) updateChatSettings(conv.id, { selectedKbIds: [] }); }}
          showDropdown={showKbDropdown}
          setShowDropdown={setShowKbDropdown}
          noKbLabel={t("chat.noKb")}
          kbCountLabel={(count) => t("chat.kbCount", { count })}
        />

        <button onClick={handleNew} className="p-1.5 hover:bg-muted rounded-md text-muted-foreground" title={t("chat.new")}><Plus className="w-4 h-4" /></button>
        <button onClick={() => setAutoScroll(!autoScroll)}
          className={`p-1.5 hover:bg-muted rounded-md ${autoScroll ? "text-primary" : "text-muted-foreground"}`} title={t("chat.autoScroll")}><ArrowDownToLine className="w-4 h-4" /></button>
        {conv.messages.length > 0 && (
          <>
            <button onClick={handleRegenerate} disabled={streaming}
              className="p-1.5 hover:bg-muted rounded-md text-muted-foreground" title={t("chat.regenerate")}><RefreshCw className="w-4 h-4" /></button>
            <button onClick={handleDelete} className="p-1.5 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500" title={t("chat.clear")}><Trash2 className="w-4 h-4" /></button>
          </>
        )}
      </div>

      {/* Selected KB tags */}
      <KBSelectedTags
        selectedKbIds={selectedKbIds}
        knowledgeBases={knowledgeBases}
        onRemove={(id) => { if (conv) updateChatSettings(conv.id, { selectedKbIds: selectedKbIds.filter((x) => x !== id) }); }}
      />

      {/* Messages — scrollRef is the scrollable viewport used by the virtualizer */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4" style={{ overflowAnchor: "auto" }}>
        {messages.length === 0 && !toolStatus ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center py-16">
              <MessageSquare className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">{t("chat.emptyHint")}</p>
              {selectedKbIds.length === 0 && <p className="text-xs text-muted-foreground mt-1">{t("chat.selectKbHint")}</p>}
            </div>
          </div>
        ) : (
          <ChatMessageList
            messages={messages}
            streaming={streaming}
            toolResults={toolResults}
            activeToolId={activeToolId}
            setPreviewChunk={setPreviewChunk}
            copiedMsgIdx={copiedMsgIdx}
            handleCopy={handleCopy}
            autoScroll={autoScroll}
            onToggleAutoScroll={() => setAutoScroll(!autoScroll)}
            scrollRef={scrollRef as React.RefObject<HTMLDivElement | null>}
          />
        )}
      </div>

      {/* Sources + Error — rendered below the message list.
          Tool execution state is shown inline via ToolCallCards inside the
          last assistant message, so no separate interstitial is needed here. */}
      <div className="px-6 shrink-0">
        <SourcesPanel
          sources={lastAssistantSources}
          onSourceClick={setPreviewChunk}
          sourcesLabel={t("chat.sources")}
        />
        {error && <div className="p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 mt-2">{error}</div>}
      </div>

      {/* Input */}
      <ChatInput
        input={input}
        setInput={setInput}
        streaming={streaming}
        onSend={handleSend}
        onStop={handleStop}
        placeholder={t("chat.placeholder")}
      />

      {/* Scroll to bottom FAB */}
      {showScrollBtn && (
        <button onClick={() => { setAutoScroll(true); scrollToBottom(); }}
          className="absolute bottom-24 right-8 z-30 p-2 bg-card border rounded-full shadow-md hover:shadow-lg transition-all animate-in fade-in"
        >
          <ArrowDown className="w-4 h-4 text-muted-foreground" />
        </button>
      )}

      {/* Chunk preview dialog */}
      {previewChunk && (
        <ChunkDetailDialog
          chunk={{
            content: previewChunk.content,
            doc_name: previewChunk.doc_name,
            doc_id: previewChunk.doc_id,
            kb_id: previewChunk.kb_id,
            chunk_index: previewChunk.metadata?.chunk_index as number | undefined,
            page_number: previewChunk.page_start ?? previewChunk.metadata?.page,
            page_start: previewChunk.page_start ?? previewChunk.metadata?.page_start,
            page_end: previewChunk.page_end ?? previewChunk.metadata?.page_end,
            score: previewChunk.score,
          }}
          onClose={() => setPreviewChunk(null)}
          onPrev={previewChunk.metadata?.chunk_index != null && previewChunk.doc_id
            ? () => navigatePreviewChunk(-1) : undefined}
          onNext={previewChunk.metadata?.chunk_index != null && previewChunk.doc_id
            ? () => navigatePreviewChunk(1) : undefined}
          hasPrev={!!(previewChunk.metadata?.chunk_index != null && previewChunk.doc_id)}
          hasNext={!!(previewChunk.metadata?.chunk_index != null && previewChunk.doc_id)}
        />
      )}
    </div>
  );
}
