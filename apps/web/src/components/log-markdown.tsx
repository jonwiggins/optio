"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  p: ({ children }) => (
    <p className="font-sans text-[13px] leading-relaxed mb-1.5 last:mb-0 break-words">{children}</p>
  ),
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through text-text-muted">{children}</del>,
  ul: ({ children }) => (
    <ul className="font-sans text-[13px] list-disc pl-5 mb-1.5 last:mb-0 space-y-0.5">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="font-sans text-[13px] list-decimal pl-5 mb-1.5 last:mb-0 space-y-0.5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ className, children, ...props }) => {
    const isBlock = typeof className === "string" && className.includes("language-");
    if (isBlock) {
      return (
        <code className={`block ${className ?? ""}`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="px-1 py-0.5 rounded bg-bg-hover text-primary font-mono text-[11px] break-all"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-bg-subtle rounded-md border border-border px-3 py-2 mb-1.5 last:mb-0 overflow-x-auto font-mono text-[11px] leading-relaxed whitespace-pre">
      {children}
    </pre>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-primary hover:underline break-all"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-primary/30 pl-3 text-text-muted italic font-sans text-[13px] mb-1.5 last:mb-0">
      {children}
    </blockquote>
  ),
  h1: ({ children }) => (
    <h1 className="font-sans font-bold text-base text-text-heading mb-1 mt-1 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-sans font-bold text-sm text-text-heading mb-1 mt-1 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-sans font-semibold text-sm text-text-heading mb-1 mt-1 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="font-sans font-semibold text-[13px] text-text-heading mb-1 mt-1 first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="font-sans font-semibold text-[13px] text-text-heading mb-1 mt-1 first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="font-sans font-semibold text-[13px] text-text-heading mb-1 mt-1 first:mt-0">
      {children}
    </h6>
  ),
  hr: () => <hr className="border-border my-2" />,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-1.5 last:mb-0 -mx-1 px-1">
      <table className="font-sans text-[12px] border-collapse w-full">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-bg-subtle">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-border last:border-b-0">{children}</tr>,
  th: ({ children, style }) => (
    <th
      className="border border-border px-2 py-1 text-left font-semibold text-text-heading"
      style={style}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="border border-border px-2 py-1 align-top" style={style}>
      {children}
    </td>
  ),
};

// Block-level markdown elements only — no images, iframes, raw HTML, or
// embedded media. react-markdown ignores raw HTML by default (we don't
// load `rehype-raw`), and we drop `img` here so markdown image syntax
// can't trigger external requests from log content.
const DISALLOWED_ELEMENTS = ["img", "iframe", "script", "style", "video", "audio", "embed"];

interface LogMarkdownProps {
  content: string;
  className?: string;
}

/**
 * Renders agent-emitted markdown text inside the log viewer. Uses
 * `remark-gfm` for tables / strikethrough / task lists. Tolerates
 * partial / unbalanced markdown (the parser is recoverable). Raw HTML
 * is not rendered — only the safe block-level subset above.
 */
export const LogMarkdown = memo(function LogMarkdown({ content, className }: LogMarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        disallowedElements={DISALLOWED_ELEMENTS}
        unwrapDisallowed
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
