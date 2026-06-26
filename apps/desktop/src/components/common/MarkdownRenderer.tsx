import { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import "katex/dist/katex.min.css";
import { open } from "@tauri-apps/plugin-shell";
import { Check, Copy } from "lucide-react";

// ── Math inside HTML (e.g. <td>$x$</td>) ──
function rehypeMathInHtml() {
  return (tree: any) => {
    const walk = (nodes: any[], parent?: any) => {
      if (!nodes) return;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.type === "element") { walk(node.children, node); }
        else if (node.type === "text" && parent) {
          const text = node.value || "";
          const mr = /\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g;
          let m; let last = 0; const reps: any[] = [];
          while ((m = mr.exec(text)) !== null) {
            if (m.index > last) reps.push({ type: "text", value: text.slice(last, m.index) });
            const isDisp = m[0].startsWith("$$");
            reps.push({ type: "element", tagName: "span",
              properties: { className: isDisp ? ["math", "math-display"] : ["math", "math-inline"] },
              children: [{ type: "text", value: isDisp ? m[1] : m[2] }] });
            last = mr.lastIndex;
          }
          if (reps.length > 0) {
            if (last < text.length) reps.push({ type: "text", value: text.slice(last) });
            nodes.splice(i, 1, ...reps); i += reps.length - 1;
          }
        }
      }
    };
    walk(tree.children);
  };
}

// ── [N] → clickable source badge ──
function embedBadges(content: string, sourceCount: number): string {
  if (!sourceCount) return content;
  const segments = content.split(/(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
  return segments.map((seg, i) => {
    if (i % 2 === 1) return seg;
    // Match [3-5] (range) or [3] (single)
    return seg.replace(/\[(\d+)(?:[-–](\d+))?\]/g, (m, n1, n2) => {
      const start = parseInt(n1) - 1;
      const end = n2 ? parseInt(n2) - 1 : start;
      if (start < 0 || end >= sourceCount || start > end) return m;
      if (start === end) {
        return `<sup data-source="${start}" class="skb-badge">${n1}</sup>`;
      }
      return `<sup data-source-start="${start}" data-source-end="${end}" class="skb-badge">${n1}-${n2}</sup>`;
    });
  }).join("");
}

/** Merge multiple sources into a single preview object */
function mergeSources(list: any[]): any {
  if (list.length === 1) return list[0];
  return {
    ...list[0],
    chunk_id: list.map(s => s.chunk_id).join("+"),
    content: list.map((s, i) =>
      `> 📄 **Chunk #${s.metadata?.chunk_index ?? (i + 1)}**\n\n${s.content}`
    ).join("\n\n---\n\n"),
    metadata: { ...list[0].metadata, _merged: true, _count: list.length, _range: `${list[0].metadata?.chunk_index ?? "?"}-${list[list.length-1].metadata?.chunk_index ?? "?"}` },
  };
}

interface Props {
  children: string;
  className?: string;
  sources?: any[];
  onSourceClick?: (source: any) => void;
}

function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = typeof children === "string" ? children : String(children ?? "");
  return (
    <div className="relative group/code">
      <button onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 border opacity-0 group-hover/code:opacity-100 transition-opacity z-10" title="Copy code">
        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>
      <pre className={className}>{children}</pre>
    </div>
  );
}

export function MarkdownRenderer({ children, className, sources, onSourceClick }: Props) {
  const count = sources?.length || 0;
  const content = count ? embedBadges(children, count) : children;

  const onClick = useCallback((e: React.MouseEvent) => {
    if (!onSourceClick || !sources) return;
    const el = (e.target as HTMLElement).closest("[data-source], [data-source-start]") as HTMLElement | null;
    if (!el) return;
    const s = el.getAttribute("data-source-start");
    if (s != null) {
      // Range badge [3-5]
      const start = parseInt(s);
      const end = parseInt(el.getAttribute("data-source-end") || s);
      if (start >= 0 && end < sources.length) {
        onSourceClick(mergeSources(sources.slice(start, end + 1)));
      }
    } else {
      // Single badge [3]
      const idx = parseInt(el.getAttribute("data-source") || "-1");
      if (idx >= 0 && idx < sources.length) onSourceClick(sources[idx]);
    }
  }, [onSourceClick, sources]);

  return (
    <div className={className} onClick={onClick}>
      <style>{`
        .skb-badge{display:inline-flex;align-items:center;justify-content:center;
          min-width:18px;height:18px;border-radius:50%;
          background:rgba(79,70,229,0.12);color:#4f46e5;
          font-size:10px;font-weight:600;text-decoration:none;
          cursor:pointer;vertical-align:super;margin:0 2px;line-height:1}
        .skb-badge:hover{background:rgba(79,70,229,0.24)}
        .dark .skb-badge{background:rgba(129,140,248,0.15);color:#a5b4fc}
        .dark .skb-badge:hover{background:rgba(129,140,248,0.28)}
      `}</style>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, rehypeMathInHtml, [rehypeKatex, { strict: false, throwOnError: false }]]}
        components={{
          a({ href, children: aChildren, ...props }) {
            if (href && /^https?:\/\//.test(href)) {
              return <a href={href} onClick={e => { e.preventDefault(); open(href!); }}
                target="_blank" rel="noopener noreferrer" className="text-primary underline cursor-pointer" {...props}>{aChildren}</a>;
            }
            return <a href={href} {...props}>{aChildren}</a>;
          },
          sup({ children: sChildren, ...props }) {
            return <sup {...props}>{sChildren}</sup>;
          },
          pre({ children: pChildren, ...props }) {
            const code = (pChildren as any)?.props;
            return <CodeBlock className={code?.className}>{code?.children || pChildren}</CodeBlock>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
