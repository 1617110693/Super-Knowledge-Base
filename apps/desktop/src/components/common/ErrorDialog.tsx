import { X, AlertTriangle } from "lucide-react";

interface Props {
  title: string;
  error: string;
  onClose: () => void;
}

export function ErrorDialog({ title, error, onClose }: Props) {
  if (!error) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl shadow-xl max-w-lg w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="w-5 h-5" />
            <h3 className="font-semibold">{title}</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded-md"><X className="w-4 h-4" /></button>
        </div>
        <pre className="text-sm text-red-700/90 whitespace-pre-wrap break-all max-h-80 overflow-y-auto">{error}</pre>
      </div>
    </div>
  );
}
