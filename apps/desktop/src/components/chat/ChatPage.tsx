import { useState, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useChatStore } from "../../stores/useChatStore";
import { useKBStore } from "../../stores/useKBStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useI18n } from "../../i18n";
import { CHAT_TOOLS, toolLabel } from "../../services/toolDefinitions";
import { executeToolCall } from "../../services/toolExecutor";
import { Send, Loader2, Trash2, MessageSquare, User, Bot, Layers, FileText, X, ChevronDown, ChevronUp, Search, Copy, Check, RefreshCw, Square, ArrowDown, ArrowDownToLine, Eye } from "lucide-react";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { ChunkDetailDialog } from "../common/ChunkDetailDialog";
import { getChunkByIndex, getChunkRange } from "../../services/pythonClient";
import { listDocuments } from "../../services/tauriBridge";
import type { ChatMessage, SearchResult, ToolCall } from "../../types";

/** Normalize LaTeX math delimiters so remark-math can process them. */
function normalizeMath(text: string): string {
  text = text.replace(/\\\((.+?)\\\)/gs, (_, m) => `$${m}$`);
  text = text.replace(/\\\[(.+?)\\\]/gs, (_, m) => `$$\n${m}\n$$`);
  text = text.replace(/\$\$\$\$/g, "$$");
  return text;
}

// Limits are read from settings now — these are fallback defaults.

/** Format a tool call argument value for display. */
function fmtArg(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

/** Collapsible tool call cards — one per tool call, expandable to show arguments. */
function ToolCallCards({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (!toolCalls || toolCalls.length === 0) return null;

  // Group consecutive calls of the same tool type
  const items = toolCalls.map((tc, i) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc.function.arguments); } catch { /* keep empty */ }
    const label = toolLabel(tc);
    const name = tc.function.name.replace(/_/g, " ");
    return { tc, args, label, name, idx: i };
  });

  return (
    <div className="space-y-1.5">
      {items.map(({ tc, args, label, name, idx }) => {
        const isExpanded = expandedIdx === idx;
        const argEntries = Object.entries(args).filter(([, v]) => v != null && v !== "" && (!Array.isArray(v) || v.length > 0));
        return (
          <div key={tc.id || idx} className="rounded-lg border bg-card/60 overflow-hidden">
            <button
              onClick={() => setExpandedIdx(isExpanded ? null : idx)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors"
            >
              <Search className="w-3 h-3 text-primary shrink-0" />
              <span className="font-medium capitalize truncate flex-1 text-left">{name}</span>
              <span className="text-muted-foreground truncate max-w-[200px] hidden sm:inline">{label}</span>
              {argEntries.length > 0 && (
                isExpanded
                  ? <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0" />
                  : <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
              )}
            </button>
            {isExpanded && argEntries.length > 0 && (
              <div className="border-t max-h-48 overflow-y-auto">
                <table className="w-full text-[11px] border-collapse">
                  <tbody>
                    {argEntries.map(([k, v]) => (
                      <tr key={k} className="border-b last:border-0">
                        <td className="px-3 py-1 text-muted-foreground font-medium w-[30%] align-top whitespace-nowrap">{k}</td>
                        <td className="px-3 py-1 font-mono whitespace-pre-wrap break-all">{fmtArg(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
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
    deleteConversation, setActiveConversation,
  } = useChatStore();

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [showKbDropdown, setShowKbDropdown] = useState(false);
  const [previewChunk, setPreviewChunk] = useState<SearchResult | null>(null);
  const [toolStatus, setToolStatus] = useState("");
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [copiedMsgIdx, setCopiedMsgIdx] = useState<number | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [contextWindow, setContextWindow] = useState(1);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadKBs(); }, []);

  const conv = conversations.find((c) => c.id === (convId || activeConversationId));
  const messages = conv?.messages || [];

  // Collect all sources from the most recent assistant message
  const lastAssistantSources = [...messages].reverse().find((m) => m.role === "assistant")?.sources || [];

  useEffect(() => {
    if (convId) setActiveConversation(convId);
    if (!convId && !activeConversationId) {
      const id = newConversation();
      navigate(`/chat/${id}`, { replace: true });
    }
  }, [convId]);

  const scrollToBottom = (smooth = true) => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  };

  useEffect(() => {
    if (autoScroll) scrollToBottom();
  }, [messages, toolStatus, autoScroll]);

  // Track scroll position for scroll-to-bottom button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(dist > 200);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const handleSend = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || streaming) return;
    const currentConv = conversations.find((c) => c.id === (convId || activeConversationId));
    if (!currentConv) return;

    const userMsg = { role: "user" as const, content: msg };
    addMessage(currentConv.id, userMsg);
    setInput("");
    setError("");
    setStreaming(true);

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
      const kbNames = selectedKbIds.length > 0
        ? selectedKbIds.map((id) => knowledgeBases.find((kb) => kb.id === id)?.name || id).join(", ")
        : "";
      const ragInstr = `You have access to knowledge bases: ${kbNames}.

HOW TO ANSWER QUESTIONS (RAG-first workflow):
1. Use search_knowledge_base to find the most relevant chunks across all KBs. This is your PRIMARY tool for answering questions — it returns precise, pre-chunked content.
2. If you need more context around a result, use get_chunk_by_index with neighboring chunk_index values, or search_knowledge_base with context_window > 0.
3. DO NOT use get_document or get_document_chunks to answer questions — documents can be hundreds of pages and will overflow context. These tools are for browsing/document management, not Q&A.
4. get_document_summary gives you a document's structure (headings, chunk count) without loading content — use it to understand what a document covers.`;
      const systemMsg = selectedKbIds.length > 0
        ? `${ragInstr}\n\n${citeInstr}\n\n${mathInstr}`
        : `You are a helpful assistant. ${mathInstr}`;

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
        const resp = await fetch(`${apiBase}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, tools: CHAT_TOOLS, tool_choice: "auto", stream: true }),
        });

        if (!resp.ok) { const err = await resp.text(); throw new Error(err); }

        const reader = resp.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();

        let fullContent = "";
        const toolCallsAcc = new Map<number, { id: string; name: string; arguments: string }>();
        let finishReason = "";

        // Throttled store updates: push to store at most every ~50ms during streaming
        let lastFlush = 0;
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const flushContent = () => {
          updateLastAssistant(currentConv.id, fullContent, allSources);
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

              if (delta?.content) {
                fullContent += delta.content;
                // Throttle: push to store every 50ms to avoid stuttery re-renders
                const now = Date.now();
                if (now - lastFlush >= 50 && !flushTimer) {
                  flushContent();
                } else if (!flushTimer) {
                  flushTimer = setTimeout(flushContent, 50 - (now - lastFlush));
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
          updateLastAssistant(currentConv.id, fullContent, allSources);
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
            try {
              const { result, newSources } = await executeToolCall(tc, kbList, {
                maxSearchResultChars: settings.max_search_result_chars || 2000,
                maxDocumentChars: settings.max_document_chars || 30000,
                maxChunkChars: settings.max_chunk_chars || 800,
              }, selectedKbIds.length > 0 ? selectedKbIds : undefined, contextWindow, allSources.length);
              allSources = [...allSources, ...newSources];
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
  const handleCopy = async (content: string, idx: number) => {
    await navigator.clipboard.writeText(content);
    setCopiedMsgIdx(idx);
    setTimeout(() => setCopiedMsgIdx(null), 2000);
  };
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
    setSelectedKbIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const kbNameById = (id: string) => knowledgeBases.find((kb) => kb.id === id)?.name || id;

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
          <select value={contextWindow} onChange={(e) => setContextWindow(Number(e.target.value))} className="px-1.5 py-0.5 border rounded bg-background text-[11px]">
            <option value="0">±0</option>
            <option value="1">±1</option>
            <option value="2">±2</option>
          </select>
        </label>

        {/* Multi-select KB dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowKbDropdown(!showKbDropdown)}
            className="text-xs border rounded-md px-2 py-1 bg-background min-w-[100px] max-w-[180px] truncate text-left flex items-center gap-1"
          >
            {selectedKbIds.length === 0
              ? t("chat.noKb")
              : selectedKbIds.length === 1
                ? kbNameById(selectedKbIds[0])
                : t("chat.kbCount", { count: selectedKbIds.length })}
            <ChevronDown className="w-3 h-3 ml-auto shrink-0" />
          </button>
          {showKbDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowKbDropdown(false)} />
              <div className="absolute top-full right-0 mt-1 z-50 bg-card border rounded-lg shadow-lg p-1.5 min-w-[200px] max-h-[280px] overflow-y-auto">
                <label className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded cursor-pointer text-xs">
                  <input type="checkbox" checked={selectedKbIds.length === 0} onChange={() => setSelectedKbIds([])} />
                  <span className="text-muted-foreground">{t("chat.noKb")}</span>
                </label>
                <hr className="my-1 border-border/50" />
                {knowledgeBases.map((kb) => (
                  <label key={kb.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded cursor-pointer text-xs">
                    <input type="checkbox" checked={selectedKbIds.includes(kb.id)} onChange={() => toggleKb(kb.id)} />
                    <span className="truncate">{kb.name}</span>
                    <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0">{kb.document_count}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <button onClick={handleNew} className="px-3 py-1 border rounded-md text-xs hover:bg-muted">{t("chat.new")}</button>
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
      {selectedKbIds.length > 1 && (
        <div className="flex flex-wrap gap-1 px-6 py-1.5 border-b shrink-0 bg-muted/20">
          {selectedKbIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary rounded-full pl-2 pr-1 py-0.5">
              {kbNameById(id)}
              <X className="w-3 h-3 cursor-pointer hover:text-red-500" onClick={() => setSelectedKbIds((prev) => prev.filter((x) => x !== id))} />
            </span>
          ))}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && !toolStatus ? (
          <div className="text-center py-16">
            <MessageSquare className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">{t("chat.emptyHint")}</p>
            {selectedKbIds.length === 0 && <p className="text-xs text-muted-foreground mt-1">{t("chat.selectKbHint")}</p>}
          </div>
        ) : (
          messages.filter((m) => m.role !== "tool").map((msg, i) => (
            <div key={i} className={`flex gap-3 group ${msg.role === "user" ? "justify-end" : ""}`}>
              {msg.role === "assistant" && (
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><Bot className="w-4 h-4 text-primary" /></div>
              )}
              <div className="relative max-w-[80%]">
                <div className={`rounded-xl px-4 py-2.5 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                  {msg.role === "assistant" && msg.content ? (
                    streaming && i === messages.length - 1 ? (
                      <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                    ) : (
                      <MarkdownRenderer
                        className="prose prose-sm max-w-none dark:prose-invert text-sm"
                        sources={msg.sources}
                        onSourceClick={(s) => setPreviewChunk(s as SearchResult)}
                      >
                        {msg.content}
                      </MarkdownRenderer>
                    )
                  ) : msg.role === "assistant" && msg.tool_calls && !msg.content ? (
                    <ToolCallCards toolCalls={msg.tool_calls} />
                  ) : msg.role === "assistant" && streaming && i === messages.length - 1 ? (
                    <Loader2 className="w-3 h-3 animate-spin inline" />
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                  )}
                </div>
                {/* Copy button on hover */}
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
          ))
        )}

        {/* Tool execution interstitial */}
        {toolStatus && streaming && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><Bot className="w-4 h-4 text-primary" /></div>
            <div className="max-w-[80%] min-w-[200px] rounded-xl border bg-muted/50 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 text-xs">
                <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" />
                <span className="text-muted-foreground truncate">{toolStatus}</span>
              </div>
            </div>
          </div>
        )}

        {/* Sources — collapsible, shows max 6 items */}
        {lastAssistantSources.length > 0 && (
          <div className="border-t pt-3 mt-2">
            <button
              onClick={() => setSourcesExpanded(!sourcesExpanded)}
              className="w-full text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1 hover:text-foreground transition-colors"
            >
              <Layers className="w-3 h-3" />
              {t("chat.sources")} ({lastAssistantSources.length})
              {sourcesExpanded
                ? <ChevronUp className="w-3 h-3 ml-auto" />
                : <ChevronDown className="w-3 h-3 ml-auto" />
              }
            </button>
            {sourcesExpanded && (
              <div className={`${lastAssistantSources.length > 6 ? "max-h-[240px] overflow-y-auto" : ""} space-y-1`}>
                {lastAssistantSources.map((s, i) => (
                  <div key={i}
                    className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 flex items-start gap-1.5 cursor-pointer hover:bg-muted transition-colors"
                    onClick={() => setPreviewChunk(s)}>
                    <FileText className="w-3 h-3 shrink-0 mt-0.5" />
                    <span className="font-mono text-[10px] text-primary/70">[{i + 1}]</span>
                    <span className="truncate">{s.doc_name}</span>
                    <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0">{(s.score * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {error && <div className="p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t shrink-0 bg-card/30">
        <div className="flex gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={t("chat.placeholder")} rows={2} disabled={streaming}
            className="flex-1 px-4 py-2.5 border rounded-xl text-sm bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50" />
          {streaming ? (
            <button onClick={handleStop}
              className="px-4 bg-red-500 text-white rounded-xl hover:bg-red-600 shrink-0 self-stretch flex items-center justify-center">
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={() => handleSend()} disabled={!input.trim()}
              className="px-4 bg-primary text-primary-foreground rounded-xl hover:opacity-90 disabled:opacity-50 shrink-0 self-stretch flex items-center justify-center">
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Scroll to bottom FAB */}
      {showScrollBtn && (
        <button onClick={() => scrollToBottom()}
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
