import { ChevronDown, X } from "lucide-react";
import type { KnowledgeBase } from "../../types";

interface KBSelectorProps {
  knowledgeBases: KnowledgeBase[];
  selectedKbIds: string[];
  onToggleKb: (id: string) => void;
  onClearAll: () => void;
  showDropdown: boolean;
  setShowDropdown: (v: boolean) => void;
  noKbLabel: string;
  kbCountLabel: (count: number) => string;
}

function kbNameById(kbs: KnowledgeBase[], id: string) {
  return kbs.find((kb) => kb.id === id)?.name || id;
}

export function KBSelector({
  knowledgeBases, selectedKbIds, onToggleKb, onClearAll,
  showDropdown, setShowDropdown, noKbLabel, kbCountLabel,
}: KBSelectorProps) {
  return (
    <div className="relative">
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="text-xs border rounded-md px-2 py-1 bg-background min-w-[100px] max-w-[180px] truncate text-left flex items-center gap-1"
      >
        {selectedKbIds.length === 0
          ? noKbLabel
          : selectedKbIds.length === 1
            ? kbNameById(knowledgeBases, selectedKbIds[0])
            : kbCountLabel(selectedKbIds.length)}
        <ChevronDown className="w-3 h-3 ml-auto shrink-0" />
      </button>
      {showDropdown && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
          <div className="absolute top-full right-0 mt-1 z-50 bg-card border rounded-lg shadow-lg p-1.5 min-w-[200px] max-h-[280px] overflow-y-auto">
            <label className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded cursor-pointer text-xs">
              <input type="checkbox" checked={selectedKbIds.length === 0} onChange={onClearAll} />
              <span className="text-muted-foreground">{noKbLabel}</span>
            </label>
            <hr className="my-1 border-border/50" />
            {knowledgeBases.map((kb) => (
              <label key={kb.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded cursor-pointer text-xs">
                <input type="checkbox" checked={selectedKbIds.includes(kb.id)} onChange={() => onToggleKb(kb.id)} />
                <span className="truncate">{kb.name}</span>
                <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0">{kb.document_count}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Render selected KB chips */
export function KBSelectedTags({ selectedKbIds, knowledgeBases, onRemove }: {
  selectedKbIds: string[];
  knowledgeBases: KnowledgeBase[];
  onRemove: (id: string) => void;
}) {
  if (selectedKbIds.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-1 px-6 py-1.5 border-b shrink-0 bg-muted/20">
      {selectedKbIds.map((id) => (
        <span key={id} className="inline-flex items-center gap-1 text-[10px] bg-primary/10 text-primary rounded-full pl-2 pr-1 py-0.5">
          {kbNameById(knowledgeBases, id)}
          <X className="w-3 h-3 cursor-pointer hover:text-red-500" onClick={() => onRemove(id)} />
        </span>
      ))}
    </div>
  );
}
