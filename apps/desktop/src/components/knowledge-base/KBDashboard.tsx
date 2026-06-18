import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useKBStore } from "../../stores/useKBStore";
import {
  Plus,
  Trash2,
  FolderOpen,
  BookOpen,
  FileText,
  Layers,
} from "lucide-react";

export function KBDashboard() {
  const navigate = useNavigate();
  const { knowledgeBases, loadKBs, createKB, deleteKB } = useKBStore();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    loadKBs();
  }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    await createKB(name, description);
    setName("");
    setDescription("");
    setShowCreate(false);
  };

  const handleDelete = async (kbId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Delete this knowledge base? All documents and indexes will be removed.")) {
      await deleteKB(kbId);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Knowledge Bases</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Manage your document collections and their indexes
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90"
        >
          <Plus className="w-4 h-4" />
          New Knowledge Base
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mb-6 p-4 border rounded-lg bg-card">
          <h3 className="font-semibold mb-3">Create Knowledge Base</h3>
          <input
            type="text"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border rounded-md mb-2 text-sm bg-background"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 border rounded-md mb-3 text-sm bg-background"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="px-4 py-1.5 bg-primary text-primary-foreground rounded-md text-sm"
            >
              Create
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-4 py-1.5 border rounded-md text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* KB list */}
      {knowledgeBases.length === 0 ? (
        <div className="text-center py-16">
          <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground text-lg">No knowledge bases yet</p>
          <p className="text-muted-foreground text-sm mt-1">
            Create one to start uploading documents
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {knowledgeBases.map((kb) => (
            <div
              key={kb.id}
              onClick={() => navigate(`/kb/${kb.id}`)}
              className="flex items-center justify-between p-4 border rounded-lg bg-card hover:border-primary/50 cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-3">
                <FolderOpen className="w-8 h-8 text-primary" />
                <div>
                  <h3 className="font-semibold">{kb.name}</h3>
                  {kb.description && (
                    <p className="text-sm text-muted-foreground">
                      {kb.description}
                    </p>
                  )}
                  <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <FileText className="w-3 h-3" />
                      {kb.document_count} docs
                    </span>
                    <span className="flex items-center gap-1">
                      <Layers className="w-3 h-3" />
                      {kb.chunk_count} chunks
                    </span>
                  </div>
                </div>
              </div>
              <button
                onClick={(e) => handleDelete(kb.id, e)}
                className="p-2 hover:bg-red-50 rounded-md text-muted-foreground hover:text-red-500 transition-colors"
                title="Delete knowledge base"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
