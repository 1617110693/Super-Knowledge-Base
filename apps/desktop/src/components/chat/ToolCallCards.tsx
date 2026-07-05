import { useState, useEffect, useRef } from "react";
import { Loader2, Search, ChevronDown, ChevronUp } from "lucide-react";
import type { ToolCall } from "../../types";
import { toolLabel } from "../../services/toolDefinitions";

/** Format a tool call argument value for display. */
function fmtArg(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

/** Collapsible tool call cards — shows request args + response, auto-expand current. */
export function ToolCallCards({ toolCalls, toolResults, activeToolId }: {
  toolCalls: ToolCall[];
  toolResults: Record<string, string>;
  activeToolId: string | null;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const manualRef = useRef<Set<string>>(new Set()); // user-toggled cards
  const prevActiveRef = useRef<string | null>(null);
  const resultsRef = useRef<Record<string, HTMLDivElement | null>>({});

  if (!toolCalls || toolCalls.length === 0) return null;

  // Auto-expand active tool, collapse previous auto-expanded ones
  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeToolId;
    if (!activeToolId) return;

    setExpandedIds(prevIds => {
      const next = new Set(manualRef.current); // keep manually-toggled
      // Remove the old active tool (if it was auto-expanded, not manual)
      if (prev && !manualRef.current.has(prev)) {
        next.delete(prev);
      }
      // Expand the new active tool
      next.add(activeToolId);
      return next;
    });

    // Auto-scroll the active result
    setTimeout(() => {
      resultsRef.current[activeToolId]?.scrollTo({ top: resultsRef.current[activeToolId]?.scrollHeight, behavior: "smooth" });
    }, 50);
  }, [activeToolId]);

  const toggle = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        manualRef.current.delete(id);
      } else {
        next.add(id);
        manualRef.current.add(id);
      }
      return next;
    });
  };

  const items = toolCalls.map((tc, i) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc.function.arguments); } catch { /* keep empty */ }
    const label = toolLabel(tc);
    const name = tc.function.name.replace(/_/g, " ");
    const result = toolResults[tc.id];
    return { tc, args, label, name, idx: i, result };
  });

  return (
    <div className="space-y-1.5 w-full max-w-full">
      {items.map(({ tc, args, label, name, idx, result }) => {
        const id = tc.id || String(idx);
        const isExpanded = expandedIds.has(id);
        const isExecuting = activeToolId === tc.id && !result;
        const argEntries = Object.entries(args).filter(([, v]) => v != null && v !== "" && (!Array.isArray(v) || v.length > 0));
        // hasBody now includes isExecuting so the chevron shows (and the card
        // is toggleable) even before any args/result arrive — no blank reserved
        // space is rendered when there's nothing to show.
        const hasBody = argEntries.length > 0 || !!result || isExecuting;
        return (
          <div key={id} className="rounded-lg border bg-card/60 overflow-hidden min-w-0">
            <button
              onClick={() => hasBody && toggle(id)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors"
            >
              {isExecuting ? <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" /> : <Search className="w-3 h-3 text-primary shrink-0" />}
              <span className="font-medium capitalize truncate flex-1 text-left">{name}</span>
              {isExecuting ? (
                // Show the running label inline in the header while executing,
                // instead of a separate placeholder block below.
                <span className="text-muted-foreground truncate max-w-[300px] hidden sm:inline">{label}</span>
              ) : (
                <span className="text-muted-foreground truncate max-w-[300px] hidden sm:inline">{label}</span>
              )}
              {hasBody && (
                isExpanded
                  ? <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0" />
                  : <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
              )}
            </button>
            {isExpanded && hasBody && (
              <div className="border-t max-h-56 overflow-y-auto" ref={el => { resultsRef.current[id] = el; }}>
                {argEntries.length > 0 && (
                  <table className="w-full text-[11px] border-collapse">
                    <tbody>
                      {argEntries.map(([k, v]) => (
                        <tr key={k} className="border-b last:border-0">
                          <td className="px-3 py-1 text-muted-foreground font-medium w-[25%] align-top whitespace-nowrap">{k}</td>
                          <td className="px-3 py-1 font-mono whitespace-pre-wrap break-all">{fmtArg(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {/* Result OR executing row — never an empty <pre> placeholder.
                    Before the result arrives we show a compact "Executing..."
                    line; once it arrives we show the result block. */}
                {result ? (
                  <div className="px-3 py-2 border-t border-dashed">
                    <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">Result</div>
                    <pre className="text-[11px] whitespace-pre-wrap break-all font-mono leading-relaxed max-h-64 overflow-y-auto">{result}</pre>
                  </div>
                ) : isExecuting ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" /> Executing...
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
