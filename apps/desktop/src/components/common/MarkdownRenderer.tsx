import { useState, useCallback, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import "katex/dist/katex.min.css";
import { open } from "@tauri-apps/plugin-shell";
import { Check, Copy } from "lucide-react";
import { readDocumentImage } from "../../services/tauriBridge";

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
  imgKbId?: string;
  imgDocId?: string;
  imgSources?: { kb_id: string; doc_id: string; content?: string }[];
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

/* Shared cache: filename → data URL (survives component re-renders) */
const _imgCache = new Map<string, string>();
const _imgResolveCache = new Map<string, { kb_id: string; doc_id: string }>();

function InlineImg({ src, alt, imgKbId, imgDocId, imgSources }: {
  src?: string; alt?: string; imgKbId?: string; imgDocId?: string;
  imgSources?: { kb_id: string; doc_id: string; content?: string }[];
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(() => _imgCache.get(src || "") || null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const pendingRef = useRef(false);

  const name = (src || "").replace(/\\/g, "/").split("/").pop() || src || "";
  const isDocImage = src?.startsWith("images/") || (!src?.match(/^https?:\/\//) && name !== src);
  // Document preview has explicit kb/doc; chat relies on imgSources
  const isDocPreview = !!(imgKbId && imgDocId);

  useEffect(() => {
    if (!src) return;
    if (error || pendingRef.current) return;
    if (dataUrl && dataUrl !== src) return;
    if (!isDocImage) { setDataUrl(src); return; }

    // Build candidate (kb, doc) pairs to try
    const candidates: { kb_id: string; doc_id: string }[] = [];

    // 1. Explicit props (document preview)
    if (imgKbId && imgDocId) candidates.push({ kb_id: imgKbId, doc_id: imgDocId });

    // 2. From imgSources: put content-matching sources first, then the rest
    if (imgSources) {
      const matching: typeof candidates = [];
      const others: typeof candidates = [];
      const seen = new Set<string>();
      const add = (kb: string, did: string) => {
        const key = `${kb}/${did}`;
        if (!seen.has(key)) { seen.add(key); others.push({ kb_id: kb, doc_id: did }); }
      };
      for (const s of imgSources) {
        if (s.content?.includes(name)) {
          matching.push({ kb_id: s.kb_id, doc_id: s.doc_id });
        } else {
          add(s.kb_id, s.doc_id);
        }
      }
      candidates.push(...matching, ...others);
    }

    if (candidates.length === 0) return;

    pendingRef.current = true;
    let loaded = false;
    (async () => {
      for (const { kb_id, doc_id } of candidates) {
        try {
          const bytes = await readDocumentImage(kb_id, doc_id, name);
          const blob = new Blob([new Uint8Array(bytes)]);
          const url = URL.createObjectURL(blob);
          _imgCache.set(src, url);
          _imgResolveCache.set(name, { kb_id, doc_id });
          setDataUrl(url);
          loaded = true;
          break;
        } catch { /* try next candidate */ }
      }
      if (!loaded) setError(true);
      pendingRef.current = false;
    })();
  }, [src, name, imgKbId, imgDocId, isDocImage, dataUrl, error]);

  if (!src) return null;
  if (error) {
    return <span className="inline-flex items-center gap-1 text-muted-foreground text-xs bg-muted/50 rounded px-2 py-1 my-1">
      🖼 {alt || name || "image"}
    </span>;
  }

  const imgUrl = dataUrl || src;

  // Document preview: full-size image, no thumbnail
  if (isDocPreview) {
    return (
      <span className="inline-block my-2">
        <img src={imgUrl} alt={alt || ""} className="max-w-full h-auto rounded-lg" loading="lazy" />
      </span>
    );
  }

  // Chat: thumbnail with click-to-expand overlay
  return (
    <span className="inline-block my-2">
      {/* Thumbnail — always rendered, never removed */}
      <span className="block relative group cursor-pointer border rounded-lg overflow-hidden bg-muted/30 max-w-[260px]"
        onClick={() => setExpanded(true)} style={{ contain: "paint layout" }}>
        <img src={imgUrl} alt={alt || ""}
          className="block w-full max-h-40 object-contain" loading="lazy" />
        {alt ? <span className="block px-2 py-1 text-[10px] text-muted-foreground truncate leading-relaxed">{alt}</span> : null}
      </span>
      {/* Fullscreen overlay — rendered on top, thumbnail stays */}
      {expanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-default"
          onClick={() => setExpanded(false)}>
          <img src={imgUrl} alt={alt || ""}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl" />
          <button onClick={() => setExpanded(false)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-lg leading-none w-8 h-8 flex items-center justify-center">
            ✕
          </button>
        </div>
      )}
    </span>
  );
}

export function MarkdownRenderer({ children, className, sources, onSourceClick, imgKbId, imgDocId, imgSources }: Props) {
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
          img({ src, alt }: any) {
            return <InlineImg src={src} alt={alt} imgKbId={imgKbId} imgDocId={imgDocId} imgSources={imgSources} />;
          },
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
