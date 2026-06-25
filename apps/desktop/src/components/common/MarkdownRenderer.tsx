import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { open } from "@tauri-apps/plugin-shell";

interface Props {
  children: string;
  className?: string;
}

export function MarkdownRenderer({ children, className }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a({ href, children: linkChildren, ...props }) {
            const handleClick = (e: React.MouseEvent) => {
              e.preventDefault();
              if (href) {
                open(href);
              }
            };
            return (
              <a
                href={href}
                onClick={handleClick}
                target="_blank"
                rel="noopener noreferrer"
                style={{ cursor: "pointer" }}
                {...props}
              >
                {linkChildren}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
