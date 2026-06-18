import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useKBStore } from "../../stores/useKBStore";
import { indexDocument } from "../../services/pythonClient";
import {
  Upload,
  FileText,
  Trash2,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  Eye,
} from "lucide-react";
import type { Document } from "../../types";

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="w-4 h-4 text-yellow-500" />,
  parsing: <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />,
  done: <CheckCircle className="w-4 h-4 text-green-500" />,
  failed: <XCircle className="w-4 h-4 text-red-500" />,
};

export function DocumentManager() {
  const { kbId } = useParams<{ kbId: string }>();
  const navigate = useNavigate();
  const { documents, loadDocuments, uploadDocument, deleteDocument, refreshDocument } =
    useKBStore();
  const [uploading, setUploading] = useState(false);
  const [indexing, setIndexing] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (kbId) loadDocuments(kbId);
  }, [kbId]);

  // Poll parsing status
  useEffect(() => {
    const interval = setInterval(() => {
      documents
        .filter((d) => d.parse_status === "parsing")
        .forEach((d) => {
          if (kbId) refreshDocument(kbId, d.id);
        });
    }, 3000);
    return () => clearInterval(interval);
  }, [documents, kbId]);

  const handleUpload = useCallback(async () => {
    if (!kbId) return;
    try {
      // Use the Tauri dialog plugin
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Documents",
            extensions: [
              "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx",
              "png", "jpg", "jpeg", "webp", "gif", "bmp", "html",
            ],
          },
        ],
      });
      if (selected) {
        setUploading(true);
        await uploadDocument(kbId, selected as string);
        if (kbId) await loadDocuments(kbId);
        setUploading(false);
      }
    } catch (e) {
      console.error("Upload failed:", e);
      setUploading(false);
    }
  }, [kbId, uploadDocument, loadDocuments]);

  const handleDelete = async (docId: string) => {
    if (!kbId) return;
    await deleteDocument(kbId, docId);
  };

  const handleIndex = async (doc: Document) => {
    if (!kbId) return;
    try {
      setIndexing((prev) => ({ ...prev, [doc.id]: true }));
      // Get document content from Rust backend
      const { getDocumentContent } = await import("../../services/tauriBridge");
      const content = await getDocumentContent(kbId, doc.id);
      await indexDocument({
        kb_id: kbId,
        doc_id: doc.id,
        doc_name: doc.name,
        markdown_content: content.markdown,
      });
      setIndexing((prev) => ({ ...prev, [doc.id]: false }));
    } catch (e) {
      console.error("Indexing failed:", e);
      setIndexing((prev) => ({ ...prev, [doc.id]: false }));
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Documents</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Upload and manage documents in this knowledge base
          </p>
        </div>
        <button
          onClick={handleUpload}
          disabled={uploading}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
          Upload Document
        </button>
      </div>

      {documents.length === 0 ? (
        <div className="text-center py-16">
          <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground text-lg">No documents yet</p>
          <p className="text-muted-foreground text-sm mt-1">
            Upload PDF, DOCX, PPTX, XLSX, images, or HTML files
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center justify-between p-3 border rounded-lg bg-card"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <FileText className="w-5 h-5 text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{doc.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(doc.file_size / 1024).toFixed(1)} KB • {doc.file_type.toUpperCase()} •{" "}
                    {doc.chunk_count} chunks
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 ml-4">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {STATUS_ICONS[doc.parse_status]}
                  {doc.parse_status}
                </span>
                {doc.parse_status === "done" && (
                  <button
                    onClick={() => handleIndex(doc)}
                    disabled={indexing[doc.id]}
                    className="px-2 py-1 bg-blue-500 text-white rounded text-xs font-medium hover:bg-blue-600 disabled:opacity-50"
                  >
                    {indexing[doc.id] ? "Indexing..." : "Index"}
                  </button>
                )}
                <button
                  onClick={() => navigate(`/kb/${kbId}/documents/${doc.id}`)}
                  className="p-1.5 hover:bg-muted rounded-md"
                  title="Preview"
                >
                  <Eye className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(doc.id)}
                  className="p-1.5 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
