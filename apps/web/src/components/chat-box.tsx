"use client";

import { useCallback, useRef, type KeyboardEvent } from "react";
import { Loader2, Send, Square } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/**
 * Scrollable bubble list for a back-and-forth between user and agent. Used by
 * the PR-review chat panel; the task page renders user messages inline in the
 * log viewer instead and does not use this component.
 */
export function ChatTranscript({
  messages,
  pending,
}: {
  messages: ChatMessage[];
  pending?: boolean;
}) {
  if (messages.length === 0 && !pending) return null;
  return (
    <div className="space-y-2 mb-3 max-h-72 overflow-y-auto pr-1">
      {messages.map((m) => (
        <div
          key={m.id}
          className={cn(
            "rounded-md p-2 text-xs whitespace-pre-wrap",
            m.role === "user"
              ? "bg-primary/10 text-text border border-primary/20"
              : "bg-bg border border-border text-text-muted",
          )}
        >
          <div className="text-[10px] uppercase tracking-wide opacity-60 mb-1">
            {m.role === "user" ? "You" : "Agent"}
          </div>
          {m.content}
        </div>
      ))}
      {pending && (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 className="w-3 h-3 animate-spin" />
          Agent is thinking...
        </div>
      )}
    </div>
  );
}

/**
 * Auto-resizing textarea + send button + optional interrupt button. Used by
 * both the task page's mid-task messaging bar and the PR-review chat panel,
 * so they share the same Enter-to-send / Shift+Enter-for-newline behaviour
 * and auto-resize feel.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  sending,
  disabled,
  placeholder = "Send a message...",
  rows = 1,
  /** Renders the destructive "Stop" button next to send. Receives the same
   * input value; the parent decides what to do (e.g. send with mode=interrupt). */
  onInterrupt,
  interruptLabel = "Stop",
  /** Override the send button label (icon-only by default on small screens). */
  sendLabel = "Send",
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  sending?: boolean;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  onInterrupt?: () => void;
  interruptLabel?: string;
  sendLabel?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sending && value.trim()) onSend();
    }
  };

  const trimmed = value.trim();
  const canSend = !disabled && !sending && !!trimmed;

  return (
    <div className="flex gap-2 items-end">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          autoResize();
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled || sending}
        rows={rows}
        className="flex-1 px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-none disabled:opacity-60"
      />
      <button
        onClick={onSend}
        disabled={!canSend}
        title={sendLabel}
        className="px-3 py-2 rounded-md text-sm font-medium transition-colors bg-primary text-white hover:bg-primary-hover disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
      >
        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        <span className="hidden sm:inline">{sendLabel}</span>
      </button>
      {onInterrupt && (
        <button
          onClick={onInterrupt}
          disabled={!canSend}
          title={interruptLabel}
          className="px-3 py-2 rounded-md text-sm font-medium transition-colors bg-warning text-white hover:bg-warning/90 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
        >
          <Square className="w-4 h-4" />
          <span className="hidden sm:inline">{interruptLabel}</span>
        </button>
      )}
    </div>
  );
}
