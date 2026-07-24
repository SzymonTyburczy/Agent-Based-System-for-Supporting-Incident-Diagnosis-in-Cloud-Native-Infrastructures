import { useEffect, useRef, useState } from "react";
import { Bot, Send, User } from "lucide-react";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

interface ChatPanelProps {
  /** Used to seed the greeting; the future data flow will hang off this id. */
  issueId: string;
}

export function ChatPanel({ issueId }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 0,
      role: "assistant",
      text: `Hi! I'm the diagnostic assistant. Ask me anything about ${issueId} — root cause hypotheses, telemetry to check, or remediation steps.`,
    },
  ]);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll only the message list, not every scrollable ancestor — scrollIntoView
    // would also drag the page itself down on stacked (sub-lg) layouts.
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    // No backend yet — messages are kept in local state only.
    setMessages((prev) => [...prev, { id: prev.length, role: "user", text }]);
    setInput("");
  };

  return (
    <div className="card flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)]">
          <Bot className="h-4 w-4 text-white" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-white">Diagnostic assistant</div>
          <div className="text-[11px] text-[var(--color-muted)]">AI chat about this incident</div>
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={[
              "flex items-start gap-2.5",
              message.role === "user" ? "flex-row-reverse" : "",
            ].join(" ")}
          >
            <div
              className={[
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                message.role === "user"
                  ? "bg-[var(--color-surface-2)]"
                  : "bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)]",
              ].join(" ")}
            >
              {message.role === "user" ? (
                <User className="h-4 w-4 text-[var(--color-muted)]" />
              ) : (
                <Bot className="h-4 w-4 text-white" />
              )}
            </div>
            <div
              className={[
                "max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap",
                message.role === "user"
                  ? "rounded-tr-sm bg-[var(--color-brand)] text-white"
                  : "rounded-tl-sm bg-[var(--color-surface-2)] text-[#e6ebf3]",
              ].join(" ")}
            >
              {message.text}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-[var(--color-border)] p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // isComposing: Enter that commits an IME candidate must not send.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask about this incident… (Enter to send, Shift+Enter for a new line)"
            rows={2}
            className="input resize-none"
            aria-label="Message to the diagnostic assistant"
          />
          <button
            onClick={send}
            disabled={!input.trim()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand)] text-white transition-colors hover:bg-[var(--color-brand)]/90 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
