import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { getDocumentContent } from "../../services/tauriBridge";
import { FileText, Loader2, ArrowLeft } from "lucide-react";

export function DocumentPreview() {
  const { kbId, docId } = useParams<{ kbId: string; docId: string }>();
  const navigate = useNavigate();
  const [content, setContent] = useState<string>("");
  const [docName, setDocName] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!kbId || !docId) return;
    getDocumentContent(kbId, docId).then((data) => {
      setContent(data.markdown);
      setDocName(data.id);
      setLoading(false);
    });
  }, [kbId, docId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <button
        onClick={() => navigate(`/kb/${kbId}`)}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>
      <div className="flex items-center gap-3 mb-6">
        <FileText className="w-6 h-6 text-primary" />
        <h2 className="text-xl font-bold">{docName}</h2>
      </div>
      <div className="prose prose-sm max-w-none dark:prose-invert bg-card p-6 rounded-lg border">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
