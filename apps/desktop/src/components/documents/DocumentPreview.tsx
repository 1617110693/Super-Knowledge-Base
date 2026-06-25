import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { getDocumentContent, saveDocumentContent, saveDocumentChunks } from "../../services/tauriBridge";
import { indexDocument } from "../../services/pythonClient";
import { useI18n } from "../../i18n";
import { FileText, Loader2, ArrowLeft, Pencil, Check, X } from "lucide-react";

/** Lazy-rendered markdown view — splits content into sections and uses
 *  content-visibility: auto so only visible sections are laid out. */
function LazyMarkdownView({ content }: { content: string }) {
  const sections = useMemo(() => {
    // Split by ## headings; if none, split by double newlines
    const byHeading = content.split(/\n(?=#{1,3}\s)/);
    if (byHeading.length > 1) return byHeading;
    // For content without headings, chunk into ~3000-char segments at paragraph breaks
    const chunks: string[] = [];
    const paragraphs = content.split(/\n\n+/);
    let current = "";
    for (const p of paragraphs) {
      if (current && current.length + p.length > 3000) {
        chunks.push(current);
        current = p;
      } else {
        current = current ? current + "\n\n" + p : p;
      }
    }
    if (current) chunks.push(current);
    return chunks.length > 1 ? chunks : [content];
  }, [content]);

  if (sections.length <= 1) {
    return (
      <div className="max-h-[calc(100vh-200px)] overflow-y-auto rounded-lg border bg-card">
        <MarkdownRenderer className="prose prose-sm max-w-none dark:prose-invert p-6">
          {content}
        </MarkdownRenderer>
      </div>
    );
  }

  return (
    <div className="max-h-[calc(100vh-200px)] overflow-y-auto rounded-lg border bg-card">
      <div className="prose prose-sm max-w-none dark:prose-invert p-6">
        {sections.map((section, i) => (
          <div key={i} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}>
            <MarkdownRenderer>
              {section}
            </MarkdownRenderer>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DocumentPreview() {
  const { kbId, docId } = useParams<{ kbId: string; docId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [content, setContent] = useState<string>("");
  const [docName, setDocName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");

  useEffect(() => {
    if (!kbId || !docId) return;
    getDocumentContent(kbId, docId).then((data) => {
      setContent(data.markdown);
      setDocName(data.name || data.id);
      setLoading(false);
    }).catch(() => {
      setDocName(docId);
      setLoading(false);
    });
  }, [kbId, docId]);

  const handleStartEdit = () => {
    setEditContent(content);
    setEditError("");
    setEditing(true);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditContent("");
    setEditError("");
  };

  const handleSave = async () => {
    if (!kbId || !docId) return;
    setSaving(true);
    setEditError("");
    try {
      // 1. Save the edited markdown content to disk
      await saveDocumentContent(kbId, docId, editContent);
      // 2. Re-index: delete old chunks + embed new content
      const result = await indexDocument({
        kb_id: kbId,
        doc_id: docId,
        doc_name: docName,
        markdown_content: editContent,
      });
      await saveDocumentChunks(kbId, docId, result.chunk_count, result.embedding_model, result.embedding_dim);
      // 3. Update local state
      setContent(editContent);
      setEditing(false);
    } catch (e) {
      setEditError(String(e));
    }
    setSaving(false);
  };

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
        <FileText className="w-6 h-6 text-primary shrink-0" />
        <h2 className="text-xl font-bold truncate">{docName}</h2>
        <div className="flex items-center gap-1 ml-auto">
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="p-1.5 hover:bg-green-50 rounded-md text-green-600"
                title={t("docs.save")}
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              </button>
              <button
                onClick={handleCancelEdit}
                disabled={saving}
                className="p-1.5 hover:bg-red-50 rounded-md text-red-500"
                title={t("kb.cancel")}
              >
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            <button
              onClick={handleStartEdit}
              className="p-1.5 hover:bg-muted rounded-md text-muted-foreground"
              title={t("docs.editMarkdown")}
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {editError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mb-4">{editError}</div>
      )}

      {editing && (
        <p className="text-xs text-muted-foreground mb-3">{t("docs.editHint")}</p>
      )}

      {editing ? (
        <textarea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          className="w-full min-h-[400px] p-4 border rounded-lg bg-background font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary"
          disabled={saving}
        />
      ) : (
        <LazyMarkdownView content={content} />
      )}
    </div>
  );
}
