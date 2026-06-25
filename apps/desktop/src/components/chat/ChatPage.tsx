import { useState, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useChatStore } from "../../stores/useChatStore";
import { useKBStore } from "../../stores/useKBStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useI18n } from "../../i18n";
import { searchAll } from "../../services/pythonClient";
import { Send, Loader2, Trash2, MessageSquare, User, Bot, Layers, FileText, X } from "lucide-react";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import type { SearchResult } from "../../types";

/** Normalize LaTeX math delimiters so remark-math can process them.
 *  Converts \(...\) → $...$ and \[...\] → $$...$$.
 *  Also detects bare LaTeX commands (e.g. \alpha, \mathbb{P}) not already
 *  inside $ delimiters and wraps them — because remark-math v6 only
 *  recognises $...$ / $$...$$ fences. */
function normalizeMath(text: string): string {
  // 1. Convert \(...\) → $...$ (inline LaTeX → remark-math inline)
  text = text.replace(/\\\((.+?)\\\)/gs, (_, m) => `$${m}$`);
  // 2. Convert \[...\] → $$...$$ (display LaTeX → remark-math display)
  text = text.replace(/\\\[(.+?)\\\]/gs, (_, m) => `$$\n${m}\n$$`);
  // 3. Fix double-dollars that became quad-dollars from the above
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
    newConversation, addMessage, updateLastAssistant,
    deleteConversation, setActiveConversation,
  } = useChatStore();

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [selectedKbId, setSelectedKbId] = useState<string>("");
  const [previewChunk, setPreviewChunk] = useState<SearchResult | null>(null);
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    const currentConv = conversations.find((c) => c.id === (convId || activeConversationId));
    if (!currentConv) return;

    const userMsg = { role: "user" as const, content: input.trim() };
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

      // RAG search
      let context = "";
      let sources: SearchResult[] = [];
      if (selectedKbId) {
        try {
          const res = await searchAll({
            kb_ids: [selectedKbId], query: userMsg.content,
            search_type: "hybrid", top_k: 5, rerank: true,
          });
          if (res.results.length > 0) {
            sources = res.results.slice(0, 5);
            context = sources
              .map((r, i) => `[${i + 1}] ${r.content}`)
              .join("\n\n");
          }
        } catch (e) { console.error("RAG search failed:", e); }
      }

      // System prompt with math + citation instructions
      const mathInstr = "Wrap ALL math in $…$ (inline) or $$…$$ (block). Examples: $\\alpha$, $\\mathbb{P}$, $x^2$, $$\\vec{x}^T A \\vec{y}$$. NEVER output raw LaTeX without $ delimiters.";
      const baseSys = context
        ? `You are a helpful assistant. Answer based on the reference sources below. When using information from a source, cite it with [N] markers.\n\n${mathInstr}\n\nReference sources:\n${context}`
        : `You are a helpful assistant. ${mathInstr}`;

      const history = [...currentConv.messages, userMsg]
        .filter((m) => m.content)
        .slice(-21);

      const resp = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: baseSys },
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ],
          stream: true,
        }),
      });

      if (!resp.ok) { const err = await resp.text(); throw new Error(err); }

      // SSE streaming
      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
                updateLastAssistant(currentConv.id, fullContent, sources);
              }
            } catch {}
          }
        }
      }
      // Normalize math delimiters before final save
      fullContent = normalizeMath(fullContent);
      updateLastAssistant(currentConv.id, fullContent, sources);
    } catch (e) {
      const errMsg = String(e);
      updateLastAssistant(currentConv.id, `Error: ${errMsg}`);
      setError(errMsg);
    }
    setStreaming(false);
  };

  const handleNew = () => { const id = newConversation(); navigate(`/chat/${id}`); };
  const handleDelete = () => {
    if (conv) { deleteConversation(conv.id); const id = newConversation(); navigate(`/chat/${id}`, { replace: true }); }
  };

  if (!conv) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0 bg-card/50">
        <MessageSquare className="w-5 h-5 text-primary" />
        <h2 className="font-semibold text-sm truncate flex-1">{conv.title || t("chat.newConversation")}</h2>
        <select value={selectedKbId} onChange={(e) => setSelectedKbId(e.target.value)}
          className="text-xs border rounded-md px-2 py-1 bg-background max-w-[160px] truncate">
          <option value="">{t("chat.noKb")}</option>
          {knowledgeBases.map((kb) => (<option key={kb.id} value={kb.id}>{kb.name}</option>))}
        </select>
        <button onClick={handleNew} className="px-3 py-1 border rounded-md text-xs hover:bg-muted">{t("chat.new")}</button>
        {conv.messages.length > 0 && (
          <button onClick={handleDelete} className="p-1.5 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500" title={t("chat.clear")}><Trash2 className="w-4 h-4" /></button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="text-center py-16">
            <MessageSquare className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">{t("chat.emptyHint")}</p>
            {!selectedKbId && <p className="text-xs text-muted-foreground mt-1">{t("chat.selectKbHint")}</p>}
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
              {msg.role === "assistant" && (
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><Bot className="w-4 h-4 text-primary" /></div>
              )}
              <div className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {msg.role === "assistant" && msg.content ? (
                  streaming && i === messages.length - 1 ? (
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                  ) : (
                    <MarkdownRenderer className="prose prose-sm max-w-none dark:prose-invert text-sm">{msg.content}</MarkdownRenderer>
                  )
                ) : msg.role === "assistant" && streaming && i === messages.length - 1 ? (
                  <Loader2 className="w-3 h-3 animate-spin inline" />
                ) : (
                  <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                )}
              </div>
              {msg.role === "user" && (
                <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5"><User className="w-4 h-4 text-primary-foreground" /></div>
              )}
            </div>
          ))
        )}
        {/* Sources — from the most recent assistant message */}
        {lastAssistantSources.length > 0 && (
          <div className="border-t pt-3 mt-2">
            <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1"><Layers className="w-3 h-3" /> {t("chat.sources")}</p>
            <div className="space-y-1">
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
          <button onClick={handleSend} disabled={streaming || !input.trim()}
            className="px-4 bg-primary text-primary-foreground rounded-xl hover:opacity-90 disabled:opacity-50 shrink-0 self-stretch flex items-center justify-center">
            {streaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Chunk preview dialog */}
      {previewChunk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPreviewChunk(null)}>
          <div className="bg-card border rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <FileText className="w-5 h-5 text-primary shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm truncate">{previewChunk.doc_name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {previewChunk.metadata?.page != null && <span>{t("search.page")} {previewChunk.metadata.page} · </span>}
                    <span className="font-mono text-primary">{(previewChunk.score * 100).toFixed(1)}%</span>
                  </p>
                </div>
              </div>
              <button onClick={() => setPreviewChunk(null)} className="p-1 hover:bg-muted rounded-md shrink-0"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              <MarkdownRenderer className="prose prose-sm max-w-none dark:prose-invert">{previewChunk.content}</MarkdownRenderer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
