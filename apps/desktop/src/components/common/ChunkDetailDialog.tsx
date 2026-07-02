import { MarkdownRenderer } from "./MarkdownRenderer";
import { useI18n } from "../../i18n";
import { useNavigate } from "react-router-dom";
import { FileText, X, ChevronLeft, ChevronRight, Eye } from "lucide-react";

export interface ChunkInfo {
  content: string;
  doc_name?: string;
  doc_id?: string;
  kb_id?: string;
  chunk_index?: number;
  page_number?: number;
  score?: number;
  prev_exists?: boolean;
  next_exists?: boolean;
}

interface Props {
  chunk: ChunkInfo;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  title?: string;
}

export function ChunkDetailDialog({ chunk, onClose, onPrev, onNext, hasPrev, hasNext, title }: Props) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const ci = chunk.chunk_index;
  const canLocate = chunk.kb_id && chunk.doc_id && ci != null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b shrink-0 gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <FileText className="w-5 h-5 text-primary shrink-0" />
            <div className="min-w-0">
              <h3 className="font-semibold text-sm truncate">{title || chunk.doc_name || t("search.chunkDetail")}</h3>
              <p className="text-xs text-muted-foreground">
                {ci != null && <span>Chunk #{ci}</span>}
                {(chunk.page_number ?? 0) > 0 && <span> · {t("search.page")} {chunk.page_number}</span>}
                {chunk.score != null && (
                  <span className="font-mono text-primary ml-1">{(chunk.score * 100).toFixed(0)}%</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {canLocate && (
              <button
                onClick={() => {
                  onClose();
                  navigate(`/kb/${chunk.kb_id}/documents/${chunk.doc_id}?ci=${ci}`);
                }}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border hover:bg-muted transition-colors"
                title={t("chat.viewFullDoc") || "View full document"}
              >
                <Eye className="w-3.5 h-3.5" />
                {t("chat.viewFullDoc")}
              </button>
            )}
            <div className="flex items-center border rounded-lg">
              <button onClick={onPrev} disabled={!hasPrev}
                className="p-1 hover:bg-muted rounded-l-md disabled:opacity-30 disabled:cursor-default transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={onNext} disabled={!hasNext}
                className="p-1 hover:bg-muted rounded-r-md disabled:opacity-30 disabled:cursor-default transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <button onClick={onClose} className="p-1 hover:bg-muted rounded-md shrink-0 ml-1"><X className="w-5 h-5" /></button>
          </div>
        </div>
        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">
          <MarkdownRenderer className="prose prose-sm max-w-none dark:prose-invert">{chunk.content}</MarkdownRenderer>
        </div>
      </div>
    </div>
  );
}
