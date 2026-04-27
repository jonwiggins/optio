"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Send, Square, Bot, Loader2 } from "lucide-react";
import { LogViewer } from "@/components/log-viewer";
import { useSessionLogs } from "@/hooks/use-session-logs";

interface SessionChatProps {
  sessionId: string;
  onCostUpdate?: (costUsd: number) => void;
  /**
   * Lets the parent (e.g. terminal) call into the chat composer to inject
   * text. The handler appends to the current draft and focuses the input.
   */
  onSendToAgent?: (handler: (text: string) => void) => void;
}

/**
 * Session chat — formerly a 600-line bespoke chat-bubble renderer; now a
 * thin shell that:
 *   1. owns the message composer (textarea + send button + interrupt),
 *   2. owns the connection status / model picker bar,
 *   3. delegates ALL message rendering to LogViewer via the
 *      composer / status / externalLogs / userMessages slots.
 *
 * Same widget Tasks / Jobs / Reviews / Agents now use, just sourced from
 * the session WebSocket and dressed up with a chat composer.
 */
export function SessionChat({ sessionId, onCostUpdate, onSendToAgent }: SessionChatProps) {
  const session = useSessionLogs(sessionId, { onCostUpdate });
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Terminal can route highlighted text into our composer.
  const sendToAgent = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev}\n\n${text}` : text));
    textareaRef.current?.focus();
  }, []);
  useEffect(() => {
    onSendToAgent?.(sendToAgent);
  }, [sendToAgent, onSendToAgent]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || session.status === "thinking") return;
    session.sendMessage(text);
    setInput("");
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const disabled = session.status === "disconnected" || session.status === "error";

  return (
    <div className="h-full flex flex-col">
      <LogViewer
        externalLogs={{
          logs: session.logs,
          connected: session.connected,
          capped: session.capped,
          clear: session.clear,
        }}
        userMessages={session.userMessages}
        emptyMessage={
          <div className="flex flex-col items-center gap-2">
            <Bot className="w-7 h-7 opacity-40" />
            <span className="text-sm font-medium">Agent Chat</span>
            <span className="text-xs max-w-xs">
              Ask the agent to write code, fix bugs, or explore the repository. It operates in the
              same worktree as your terminal.
            </span>
          </div>
        }
        status={
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "w-2 h-2 rounded-full",
                  session.status === "thinking"
                    ? "bg-primary animate-pulse"
                    : session.status === "ready" || session.status === "idle"
                      ? "bg-success"
                      : session.status === "connecting"
                        ? "bg-warning animate-pulse"
                        : "bg-error",
                )}
              />
              <span className="font-medium capitalize">{session.status}</span>
              {session.status === "thinking" ? (
                <Loader2 className="w-3 h-3 animate-spin text-text-muted" />
              ) : null}
            </div>
            <div className="flex items-center gap-3 text-text-muted/80">
              <span className="font-mono text-[11px]">{session.model}</span>
              {session.costUsd > 0 ? (
                <span className="font-mono text-[11px] tabular-nums">
                  ${session.costUsd.toFixed(4)}
                </span>
              ) : null}
            </div>
          </div>
        }
        composer={
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
              }}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder={
                session.status === "thinking"
                  ? "Agent is working…"
                  : disabled
                    ? "Disconnected"
                    : "Ask the agent…"
              }
              rows={1}
              className={cn(
                "flex-1 resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm",
                "placeholder:text-text-muted/60 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/50",
                "disabled:opacity-50 disabled:cursor-not-allowed min-h-[36px] max-h-[120px]",
              )}
            />
            {session.status === "thinking" ? (
              <button
                onClick={session.interrupt}
                className="shrink-0 p-2 rounded-md bg-error/10 text-error hover:bg-error/20 transition-colors"
                title="Interrupt"
              >
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() || disabled}
                className={cn(
                  "shrink-0 p-2 rounded-md transition-colors",
                  input.trim() && !disabled
                    ? "bg-primary text-white hover:bg-primary-hover"
                    : "bg-bg-card text-text-muted/40 border border-border",
                )}
                title="Send (Enter)"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        }
      />
    </div>
  );
}
