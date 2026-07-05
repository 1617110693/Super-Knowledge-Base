import { useMemo, memo } from "react";
import { Streamdown } from "streamdown";
import { math } from "@streamdown/math";
import { cjk } from "@streamdown/cjk";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import "streamdown/styles.css";
import { open } from "@tauri-apps/plugin-shell";
import { embedBadges, InlineImg } from "../common/MarkdownRenderer";

/** Normalize LaTeX delimiters so the math plugin can process them. */
function normalizeMath(text: string): string {
  text = text.replace(/\\\((.+?)\\\)/gs, (_, m) => `$${m}$`);
  text = text.replace(/\\\[(.+?)\\\]/gs, (_, m) => `$$\n${m}\n$$`);
  text = text.replace(/\$\$\$\$/g, "$$");
  return text;
}

export interface ChatMarkdownProps {
  /** Raw markdown content (may be incomplete during streaming). */
  children: string;
  /** True while the assistant is still streaming this message. */
  isStreaming?: boolean;
  /** Search sources for [N] citation badges + inline image lookup. */
  sources?: any[];
  /** Click handler for citation badges. */
  onSourceClick?: (source: any) => void;
  /** KB id for resolving document images. */
  imgKbId?: string;
  /** Doc id for resolving document images. */
  imgDocId?: string;
  className?: string;
}

/** CJK + remark-gfm presets for the cjk plugin (runs after remarkGfm). */
// `cjk` is a pre-configured plugin object exported by @streamdown/cjk (not a
// factory). `math` and `cjk` are cast through any because @streamdown/math
// resolves unified@11.0.5 while streamdown@2.5.0 expects unified@11.0.0 types —
// a structural-only mismatch that is fine at runtime.
const PLUGINS_OBJ: any = { math, cjk };

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeRaw];

/**
 * Streaming-optimized markdown renderer for chat messages.
 *
 * Uses Vercel's `streamdown` which incrementally parses incomplete markdown
 * (handles half-written code fences, unclosed math, etc.) without re-parsing
 * the whole string on every token — avoiding the OOM we hit when re-running
 * react-markdown + KaTeX every 80ms during streaming.
 *
 * Streaming and final states use the SAME renderer so the user sees formatted
 * markdown (headings, lists, code, formulas) appear as it arrives.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  isStreaming = false,
  sources,
  onSourceClick,
  imgKbId,
  imgDocId,
  className,
}: ChatMarkdownProps) {
  const count = sources?.length || 0;
  const content = useMemo(() => {
    // Normalize \(...\) / \[...\] delimiters so the math plugin renders them,
    // then inject [N] citation badges as raw HTML (parsed by rehype-raw).
    const normalized = normalizeMath(children);
    return count ? embedBadges(normalized, count) : normalized;
  }, [children, count]);

  // Source-badge click handler (delegated on container)
  const onClick = (e: React.MouseEvent) => {
    if (!onSourceClick || !sources) return;
    const el = (e.target as HTMLElement).closest(
      "[data-source], [data-source-start]",
    ) as HTMLElement | null;
    if (!el) return;
    const s = el.getAttribute("data-source-start");
    if (s != null) {
      const start = parseInt(s);
      const end = parseInt(el.getAttribute("data-source-end") || s);
      if (start >= 0 && end < sources.length) {
        onSourceClick(
          start === end
            ? sources[start]
            : { ...sources[start], _merged: true },
        );
      }
    } else {
      const idx = parseInt(el.getAttribute("data-source") || "-1");
      if (idx >= 0 && idx < sources.length) onSourceClick(sources[idx]);
    }
  };

  // Stable components override — only re-create if image refs change
  const components = useMemo(
    () => ({
      img({ src, alt }: any) {
        return (
          <InlineImg
            src={src}
            alt={alt}
            imgKbId={imgKbId}
            imgDocId={imgDocId}
            imgSources={sources as any}
          />
        );
      },
      a({ href, children: aChildren, ...props }: any) {
        if (href && /^https?:\/\//.test(href)) {
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                open(href!);
              }}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline cursor-pointer"
              {...props}
            >
              {aChildren}
            </a>
          );
        }
        return (
          <a href={href} {...props}>
            {aChildren}
          </a>
        );
      },
    }),
    [imgKbId, imgDocId, sources],
  );

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
      <Streamdown
        mode={isStreaming ? "streaming" : "static"}
        parseIncompleteMarkdown={isStreaming}
        plugins={PLUGINS_OBJ}
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        animated={isStreaming}
        isAnimating={isStreaming}
      >
        {content}
      </Streamdown>
    </div>
  );
}, (prev, next) => {
  // Skip re-render unless the markdown string, streaming flag, or source refs change
  return (
    prev.children === next.children &&
    prev.isStreaming === next.isStreaming &&
    prev.sources === next.sources &&
    prev.onSourceClick === next.onSourceClick &&
    prev.imgKbId === next.imgKbId &&
    prev.imgDocId === next.imgDocId &&
    prev.className === next.className
  );
});
