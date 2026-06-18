import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useKBStore } from "../../stores/useKBStore";
import { FileText, Layers, Search, MessageSquare, FolderOpen } from "lucide-react";

export function KBSettings() {
  const { kbId } = useParams<{ kbId: string }>();
  const navigate = useNavigate();
  const { knowledgeBases, loadKBs, setActiveKB } = useKBStore();

  useEffect(() => {
    loadKBs();
  }, []);

  const kb = knowledgeBases.find((k) => k.id === kbId);

  useEffect(() => {
    if (kb) setActiveKB(kb);
  }, [kb]);

  if (!kb) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Knowledge base not found
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <FolderOpen className="w-10 h-10 text-primary" />
        <div>
          <h2 className="text-2xl font-bold">{kb.name}</h2>
          {kb.description && (
            <p className="text-muted-foreground">{kb.description}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="p-4 border rounded-lg bg-card text-center">
          <FileText className="w-8 h-8 text-primary mx-auto mb-2" />
          <p className="text-2xl font-bold">{kb.document_count}</p>
          <p className="text-sm text-muted-foreground">Documents</p>
        </div>
        <div className="p-4 border rounded-lg bg-card text-center">
          <Layers className="w-8 h-8 text-primary mx-auto mb-2" />
          <p className="text-2xl font-bold">{kb.chunk_count}</p>
          <p className="text-sm text-muted-foreground">Chunks</p>
        </div>
        <div className="p-4 border rounded-lg bg-card text-center">
          <p className="text-sm text-muted-foreground mt-1">
            Created: {new Date(kb.created_at).toLocaleDateString()}
          </p>
          <p className="text-sm text-muted-foreground">
            Updated: {new Date(kb.updated_at).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => navigate(`/kb/${kbId}/documents`)}
          className="flex items-center gap-3 p-4 border rounded-lg hover:border-primary/50 transition-colors text-left"
        >
          <FileText className="w-6 h-6 text-primary" />
          <div>
            <p className="font-semibold">Manage Documents</p>
            <p className="text-sm text-muted-foreground">
              Upload, parse, and index documents
            </p>
          </div>
        </button>
        <button
          onClick={() => navigate(`/kb/${kbId}/search`)}
          className="flex items-center gap-3 p-4 border rounded-lg hover:border-primary/50 transition-colors text-left"
        >
          <Search className="w-6 h-6 text-primary" />
          <div>
            <p className="font-semibold">Search</p>
            <p className="text-sm text-muted-foreground">
              Find content in this knowledge base
            </p>
          </div>
        </button>
        <button
          onClick={() => navigate(`/kb/${kbId}/chat`)}
          className="flex items-center gap-3 p-4 border rounded-lg hover:border-primary/50 transition-colors text-left"
        >
          <MessageSquare className="w-6 h-6 text-primary" />
          <div>
            <p className="font-semibold">Chat</p>
            <p className="text-sm text-muted-foreground">
              Ask questions about your documents
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
