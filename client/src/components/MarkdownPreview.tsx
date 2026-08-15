import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProps {
  content: string;
  /** "base" (16px) when the Markdown is the page's primary content. Default "sm". */
  size?: "sm" | "base";
  /** "agent" neutralizes images in LLM-authored text. Default "user". */
  source?: "user" | "agent";
}

// Module-level so their identity is stable and `memo` is not defeated. Each
// destructures only what it renders, so react-markdown's `node` prop is
// dropped naturally and `noUnusedParameters` stays satisfied.
const baseComponents: Components = {
  // Typography gives GFM tables no wrapper and sets no overflow of their own.
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
  // Report content is LLM-authored: never navigate the SPA away in place.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

const agentComponents: Components = {
  ...baseComponents,
  // Agent-authored text must not silently fetch a pixel from an arbitrary host.
  img: ({ alt }) => <span className="text-[var(--color-muted)]">[image: {alt ?? "untitled"}]</span>,
};

/**
 * Memoized: remark parses the whole document synchronously on every render,
 * so unrelated parent state changes (e.g. typing in the Author field) must not
 * re-trigger it.
 */
export const MarkdownPreview = memo(function MarkdownPreview({
  content,
  size = "sm",
  source = "user",
}: MarkdownPreviewProps) {
  if (!content.trim()) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
        Markdown preview will appear here.
      </div>
    );
  }

  // A union rather than a className passthrough: passing "prose-base" next to
  // the component's own "prose-sm" would leave both on the element, and the
  // winner would be decided by CSS source order rather than by the caller.
  const sizeClass = size === "base" ? "prose-base" : "prose-sm";

  return (
    <div
      className={[
        "prose prose-invert max-w-none [overflow-wrap:anywhere]",
        sizeClass,
        "prose-headings:text-white prose-a:text-[var(--color-brand)]",
        "prose-code:text-[var(--color-brand-2)] prose-pre:bg-[var(--color-bg)]",
        // Typography injects literal backticks via code::before/after; incident
        // reports are dense with pod and metric names, so they read as a bug.
        "prose-code:before:content-none prose-code:after:content-none",
        // prose-code:* also recolours code INSIDE <pre>, which would render a
        // whole kubectl/YAML block in brand purple at ~4.6:1 on this background.
        "prose-pre:text-[#e6ebf3] [&_pre_code]:text-[#e6ebf3]",
      ].join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={source === "agent" ? agentComponents : baseComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
