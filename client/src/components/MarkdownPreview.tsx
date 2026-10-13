import { memo, useMemo, type ComponentProps, type ElementType } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { InlineCitation } from "./CitationChip";
import { citationKeyFromHref } from "../lib/citations";
import type { TextRange } from "../lib/fragment";

type Source = "user" | "agent" | "knowledge-base";

interface MarkdownPreviewProps {
  content: string;
  /** "base" (16px) when the Markdown is the page's primary content. Default "sm". */
  size?: "sm" | "base";
  /**
   * Who wrote the text. Default "user". Anything else has its images
   * neutralized: "agent" text is LLM-authored, and "knowledge-base" text may
   * come from a third-party PDF.
   */
  source?: Source;
  /**
   * Offsets into `content` (as `locateFragment` returns them): every block
   * element whose source overlaps the range is highlighted and carries
   * `data-cite-highlight`, for the caller to scroll to.
   */
  highlight?: TextRange | null;
  /** Renders `#cite-KBn` links (see `linkifyCitations`) as citation chips calling this. */
  onCite?: (key: string) => void;
}

// Report content is LLM-authored: never navigate the SPA away in place.
function ExternalLink({ href, children }: ComponentProps<"a">) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
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
  a: ExternalLink,
};

const untrustedComponents: Components = {
  ...baseComponents,
  // Untrusted text must not silently fetch a pixel from an arbitrary host.
  img: ({ alt }) => <span className="text-[var(--color-muted)]">[image: {alt ?? "untitled"}]</span>,
};

// The blocks a highlight is painted on. A list or a table row is not on it:
// the item or the table is the unit a reader recognises as "this passage".
const HIGHLIGHT_TAGS = [
  "p",
  "li",
  "pre",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
] as const;
type HighlightTag = (typeof HIGHLIGHT_TAGS)[number];

type HastNode = NonNullable<ExtraProps["node"]>;
type HastChild = HastNode["children"][number];

// What a list item may hold besides its own text.
const BLOCK_CHILD_TAGS = new Set(["p", "ul", "ol", "pre", "blockquote", "table", "hr"]);

/** Whether the Markdown source of `node` overlaps `range` (half-open, like remark's offsets). */
function overlaps(node: HastNode | HastChild | undefined, range: TextRange): boolean {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  return start !== undefined && end !== undefined && start < range.end && end > range.start;
}

/**
 * Whether a list item's own text, rather than only a block nested in it,
 * overlaps `range`. A tight item holds its text directly, before any nested
 * list; a loose one wraps it in a `p`, which is highlighted on its own.
 */
function ownTextOverlaps(node: HastNode | undefined, range: TextRange): boolean {
  return (node?.children ?? []).some(
    (child) =>
      !(child.type === "element" && BLOCK_CHILD_TAGS.has(child.tagName)) && overlaps(child, range),
  );
}

function highlightProps(hit: boolean, className?: string, ownText = false) {
  if (!hit) return { className };
  return {
    className: className ? `${className} cite-highlight` : "cite-highlight",
    "data-cite-highlight": "",
    // Keeps the tint on an item whose highlighted sub-items would otherwise
    // clear it (see `.cite-highlight` in index.css).
    ...(ownText && { "data-cite-own": "" }),
  };
}

function highlightable(tag: HighlightTag, range: TextRange) {
  const Tag = tag as ElementType;
  return function Highlightable({
    node,
    className,
    ...props
  }: ComponentProps<HighlightTag> & ExtraProps) {
    const hit = overlaps(node, range);
    const ownText = hit && tag === "li" && ownTextOverlaps(node, range);
    return <Tag {...props} {...highlightProps(hit, className, ownText)} />;
  };
}

/** The module-level set when neither prop is used; otherwise a copy extended with them. */
function buildComponents(
  source: Source,
  range: TextRange | null,
  onCite: ((key: string) => void) | undefined,
): Components {
  const base = source === "user" ? baseComponents : untrustedComponents;
  if (!range && !onCite) return base;
  const components: Components = { ...base };

  if (range) {
    Object.assign(
      components,
      Object.fromEntries(HIGHLIGHT_TAGS.map((tag) => [tag, highlightable(tag, range)])),
    );
    components.table = ({ node, children }) => (
      <div {...highlightProps(overlaps(node, range), "overflow-x-auto")}>
        <table>{children}</table>
      </div>
    );
  }

  if (onCite) {
    components.a = ({ href, children }) => {
      const key = citationKeyFromHref(href);
      if (key === null) return <ExternalLink href={href}>{children}</ExternalLink>;
      // `linkifyCitations` writes the link text as the bare number.
      const label = typeof children === "string" ? children : key;
      return <InlineCitation label={label} onOpen={() => onCite(key)} />;
    };
  }

  return components;
}

/**
 * Memoized: remark parses the whole document synchronously on every render,
 * so unrelated parent state changes (e.g. typing in the Author field) must not
 * re-trigger it.
 */
export const MarkdownPreview = memo(function MarkdownPreview({
  content,
  size = "sm",
  source = "user",
  highlight = null,
  onCite,
}: MarkdownPreviewProps) {
  // Keyed on the offsets, not the object: a new component identity remounts
  // every element of that type, and with it the whole document.
  const start = highlight?.start ?? null;
  const end = highlight?.end ?? null;
  const components = useMemo(
    () => buildComponents(source, start === null || end === null ? null : { start, end }, onCite),
    [source, start, end, onCite],
  );

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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
