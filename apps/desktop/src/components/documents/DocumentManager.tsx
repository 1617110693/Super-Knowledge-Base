import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useKBStore } from "../../stores/useKBStore";
import { useI18n } from "../../i18n";
import { indexDocument } from "../../services/pythonClient";
import { Upload, FileText, Trash2, Loader2, CheckCircle, XCircle, Clock, Eye } from "lucide-react";
import type { Document } from "../../types";

const STATUS_MAP: Record<string, { icon: React.ReactNode; labelKey: "parse.pending" | "parse.parsing" | "parse.done" | "parse.failed" }> = {
  pending: { icon: <Clock className="w-4 h-4 text-yellow-500" />, labelKey: "parse.pending" },
  parsing: { icon: <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />, labelKey: "parse.parsing" },
  done: { icon: <CheckCircle className="w-4 h-4 text-green-500" />, labelKey: "parse.done" },
  failed: { icon: <XCircle className="w-4 h-4 text-red-500" />, labelKey: "parse.failed" },
};

export function DocumentManager() {
  const { kbId } = useParams<{ kbId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { documents, loadDocuments, uploadDocument, deleteDocument, refreshDocument } = useKBStore();
  const [uploading, setUploading] = useState(false);
  const [indexing, setIndexing] = useState<Record<string, boolean>>({});

  useEffect(() => { if (kbId) loadDocuments(kbId); }, [kbId]);

  useEffect(() => {
    const interval = setInterval(() => {
      documents.filter((d) => d.parse_status === "parsing").forEach((d) => {
        if (kbId) refreshDocument(kbId, d.id);
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [documents, kbId]);

  const handleUpload = useCallback(async () => {
    if (!kbId) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: t("docs.uploadFilter"), extensions: ["pdf","doc","docx","ppt","pptx","xls","xlsx","png","jpg","jpeg","webp","gif","bmp","html","md","markdown","txt","zip"] }],
      });
      if (selected) {
        setUploading(true);
        await uploadDocument(kbId, selected as string);
        if (kbId) await loadDocuments(kbId);
        setUploading(false);
      }
    } catch (e) { console.error(e); setUploading(false); }
  }, [kbId, uploadDocument, loadDocuments, t]);

  const handleDelete = async (docId: string) => { if (kbId) await deleteDocument(kbId, docId); };

  const handleIndex = async (doc: Document) => {
    if (!kbId) return;
    try {
      setIndexing((p) => ({ ...p, [doc.id]: true }));
      const { getDocumentContent } = await import("../../services/tauriBridge");
      const content = await getDocumentContent(kbId, doc.id);
      await indexDocument({ kb_id: kbId, doc_id: doc.id, doc_name: doc.name, markdown_content: content.markdown });
      setIndexing((p) => ({ ...p, [doc.id]: false }));
    } catch (e) { console.error(e); setIndexing((p) => ({ ...p, [doc.id]: false })); }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">{t("docs.title")}</h2>
          <p className="text-muted-foreground text-sm mt-1">{t("docs.desc")}</p>
        </div>
        <button onClick={handleUpload} disabled={uploading}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50">
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {t("docs.upload")}
        </button>
      </div>

      {documents.length === 0 ? (
        <div className="text-center py-16">
          <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground text-lg">{t("docs.empty")}</p>
          <p className="text-muted-foreground text-sm mt-1">{t("docs.emptyHint")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => {
            const status = STATUS_MAP[doc.parse_status] || STATUS_MAP.pending;
            return (
              <div key={doc.id} className="flex items-center justify-between p-3 border rounded-lg bg-card">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <FileText className="w-5 h-5 text-primary shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{doc.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(doc.file_size / 1024).toFixed(1)} KB &bull; {doc.file_type.toUpperCase()} &bull; {doc.chunk_count} {t("kb.chunks")}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {status.icon}{t(status.labelKey)}
                  </span>
                  {doc.parse_status === "done" && (
                    <button onClick={() => handleIndex(doc)} disabled={indexing[doc.id]}
                      className="px-2 py-1 bg-blue-500 text-white rounded text-xs font-medium hover:bg-blue-600 disabled:opacity-50">
                      {indexing[doc.id] ? t("docs.indexing") : t("docs.index")}
                    </button>
                  )}
                  <button onClick={() => navigate(`/kb/${kbId}/documents/${doc.id}`)}
                    className="p-1.5 hover:bg-muted rounded-md" title={t("docs.preview")}><Eye className="w-4 h-4" /></button>
                  <button onClick={() => handleDelete(doc.id)}
                    className="p-1.5 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500" title={t("docs.delete")}><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
