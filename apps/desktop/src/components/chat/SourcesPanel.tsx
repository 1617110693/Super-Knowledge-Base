import { useState } from "react";
import { Layers, FileText, ChevronDown, ChevronUp } from "lucide-react";
import type { SearchResult } from "../../types";

interface SourcesPanelProps {
  sources: SearchResult[];
  onSourceClick: (s: SearchResult) => void;
  sourcesLabel: string;
}

export function SourcesPanel({ sources, onSourceClick, sourcesLabel }: SourcesPanelProps) {
  const [expanded, setExpanded] = useState(false);
  if (sources.length === 0) return null;

  return (
    <div className="border-t pt-3 mt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1 hover:text-foreground transition-colors"
      >
        <Layers className="w-3 h-3" />
        {sourcesLabel} ({sources.length})
        {expanded
          ? <ChevronUp className="w-3 h-3 ml-auto" />
          : <ChevronDown className="w-3 h-3 ml-auto" />
        }
      </button>
      {expanded && (
        <div className={`${sources.length > 6 ? "max-h-[240px] overflow-y-auto" : ""} space-y-1`}>
          {sources.map((s, i) => (
            <div key={i}
              className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 flex items-start gap-1.5 cursor-pointer hover:bg-muted transition-colors"
              onClick={() => onSourceClick(s)}>
              <FileText className="w-3 h-3 shrink-0 mt-0.5" />
              <span className="font-mono text-[10px] text-primary/70">[{i + 1}]</span>
              <span className="truncate">{s.doc_name}</span>
              <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0">{(s.score * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
