"use client";

import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** The text of a heading's children (strings, code spans, links). */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return Children.toArray(node).map(textOf).join("");
}

/**
 * A heading's anchor as GitLab and GitHub make it: lower case, punctuation
 * dropped, spaces to hyphens. So the guide's table of contents
 * (`[Sign in](#sign-in)`) works in the repository and in the app alike.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * Where a link in the guide goes in the app. Another doc of the repository
 * (`options.md`) isn't served here: it stays text, named as a file
 * in the Optio source. Anchors stay in the page; web links open as links.
 */
export function guideLink(
  href: string | undefined,
): { kind: "anchor" | "external"; href: string } | { kind: "doc"; file: string } | null {
  if (!href) return null;
  if (href.startsWith("#")) return { kind: "anchor", href };
  if (/^https?:\/\//i.test(href)) return { kind: "external", href };
  const path = href.split("#")[0];
  if (path.endsWith(".md")) {
    return { kind: "doc", file: `docs/${path.replace(/^(\.\/)+/, "")}` };
  }
  return null;
}

function heading(level: 2 | 3 | 4) {
  const Tag = `h${level}` as const;
  const cls = {
    2: "text-lg font-semibold text-text-heading mt-10 mb-3 pb-2 border-b border-border/60 scroll-mt-6",
    3: "text-base font-semibold text-text-heading mt-6 mb-2 scroll-mt-6",
    4: "text-sm font-semibold text-text-heading mt-4 mb-2 scroll-mt-6",
  }[level];
  return function Heading({ children }: { children?: ReactNode }) {
    return (
      <Tag id={slugify(textOf(children))} className={cls}>
        {children}
      </Tag>
    );
  };
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-2xl font-bold tracking-tight text-text-heading mb-4">{children}</h1>
  ),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  p: ({ children }) => <p className="text-sm leading-relaxed text-text my-3">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-3 space-y-1.5 text-sm leading-relaxed">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-3 space-y-1.5 text-sm leading-relaxed">{children}</ol>
  ),
  li: ({ children }) => <li className="text-text">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-text-heading">{children}</strong>,
  code: ({ className, children }) =>
    typeof className === "string" && className.includes("language-") ? (
      <code className={`block ${className}`}>{children}</code>
    ) : (
      <code className="px-1 py-0.5 rounded bg-bg-hover font-mono text-[12px] break-words">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="my-3 rounded-lg border border-border bg-bg-subtle px-4 py-3 overflow-x-auto font-mono text-[12px] leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-bg-subtle/70">{children}</thead>,
  th: ({ children }) => (
    <th className="text-left font-medium text-text-heading px-3 py-2 border-b border-border">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="align-top px-3 py-2 border-b border-border/50 text-text">{children}</td>
  ),
  a: ({ href, children }) => {
    const link = guideLink(href);
    if (!link) return <>{children}</>;
    if (link.kind === "doc") {
      return (
        <span title={`${link.file} in the Optio source`} className="underline decoration-dotted">
          {children}
        </span>
      );
    }
    return link.kind === "external" ? (
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {children}
      </a>
    ) : (
      <a href={link.href} className="text-primary hover:underline">
        {children}
      </a>
    );
  },
};

/** The people's guide (docs/using-optio.md), rendered for /help. */
export function GuideMarkdown({ source }: { source: string }) {
  return (
    <article className="max-w-3xl" data-testid="guide">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </article>
  );
}
