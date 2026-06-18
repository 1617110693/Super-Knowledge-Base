import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getDocumentContent } from "../../services/tauriBridge";
import { FileText, Loader2 } from "lucide-react";

export function DocumentPreview() {
  const { kbId, docId } = useParams<{ kbId: string; docId: string }>();
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
      <div className="flex items-center gap-3 mb-6">
        <FileText className="w-6 h-6 text-primary" />
        <h2 className="text-xl font-bold">{docName}</h2>
      </div>
      <div className="prose prose-sm max-w-none dark:prose-invert bg-card p-6 rounded-lg border">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
