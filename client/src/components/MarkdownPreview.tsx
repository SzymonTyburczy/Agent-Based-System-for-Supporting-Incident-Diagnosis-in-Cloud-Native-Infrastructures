import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProps {
  content: string;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  if (!content.trim()) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
        Markdown preview will appear here.
      </div>
    );
  }

  return (
    <div className="prose prose-invert prose-sm prose-headings:text-white prose-a:text-[var(--color-brand)] prose-code:text-[var(--color-brand-2)] prose-pre:bg-[var(--color-bg)] max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
