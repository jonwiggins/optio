"use client";

import { useCallback, useRef, type KeyboardEvent } from "react";
import { Loader2, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

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
        className={inputClass({ className: "flex-1 resize-none" })}
      />
      <Button onClick={onSend} disabled={!canSend} title={sendLabel}>
        {sending ? <Loader2 className="animate-spin" /> : <Send />}
        <span className="hidden sm:inline">{sendLabel}</span>
      </Button>
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
