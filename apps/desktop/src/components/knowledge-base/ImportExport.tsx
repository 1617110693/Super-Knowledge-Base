import { Download, Upload, FolderOpen } from "lucide-react";

export function ImportExport() {
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Import / Export</h2>

      <div className="space-y-6">
        <div className="p-6 border rounded-lg bg-card">
          <div className="flex items-center gap-3 mb-3">
            <Download className="w-6 h-6 text-primary" />
            <h3 className="text-lg font-semibold">Export Knowledge Base</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Export your knowledge base data (LanceDB indexes). The exported archive
            can be imported on another machine.
          </p>
          <ol className="text-sm text-muted-foreground list-decimal ml-4 mb-4 space-y-1">
            <li>The LanceDB data directory is located in the app data folder</li>
            <li>
              Copy the <code className="bg-muted px-1 rounded">lancedb_data/</code>{" "}
              directory to backup
            </li>
            <li>To restore, place the directory in the same location</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            File-based import/export will be available in a future update.
          </p>
        </div>
      </div>
    </div>
  );
}
