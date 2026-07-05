import { Send, Square } from "lucide-react";

interface ChatInputProps {
  input: string;
  setInput: (v: string) => void;
  streaming: boolean;
  onSend: (text?: string) => void;
  onStop: () => void;
  placeholder: string;
}

export function ChatInput({ input, setInput, streaming, onSend, onStop, placeholder }: ChatInputProps) {
  return (
    <div className="px-6 py-4 border-t shrink-0 bg-card/30">
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          placeholder={placeholder}
          rows={2}
          disabled={streaming}
          className="flex-1 px-4 py-2.5 border rounded-xl text-sm bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
        />
        {streaming ? (
          <button onClick={onStop}
            className="px-4 bg-red-500 text-white rounded-xl hover:bg-red-600 shrink-0 self-stretch flex items-center justify-center">
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button onClick={() => onSend()} disabled={!input.trim()}
            className="px-4 bg-primary text-primary-foreground rounded-xl hover:opacity-90 disabled:opacity-50 shrink-0 self-stretch flex items-center justify-center">
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
