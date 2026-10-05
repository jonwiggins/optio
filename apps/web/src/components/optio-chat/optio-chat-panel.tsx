"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";
import { OptioMark } from "@/components/optio-mark";
import { X, Send, RotateCcw, User, Loader2, AlertCircle, Info } from "lucide-react";
import {
  useOptioChatStore,
  DEFAULT_MAX_EXCHANGES,
  type OptioChatMessage,
  type OptioPendingAction,
} from "@/hooks/use-optio-chat";
import { ActionCard } from "./action-card.js";
import { api } from "@/lib/api-client";
import { ChatMarkdown } from "./chat-markdown.js";

export function OptioChatPanel() {
  const {
    isOpen,
    close,
    messages,
    addMessage,
    updateMessage,
    resetMessages,
    prefillInput,
    setPrefillInput,
    status,
    setStatus,
    exchangeCount,
    incrementExchange,
    maxTurns,
    setMaxTurns,
    confirmWrites,
    setConfirmWrites,
  } = useOptioChatStore();

  const [input, setInput] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const prevPathname = useRef(pathname);

  // Reset conversation on page navigation
  useEffect(() => {
    if (prevPathname.current !== pathname) {
      resetMessages();
      prevPathname.current = pathname;
    }
  }, [pathname, resetMessages]);

  // Apply prefill input
  useEffect(() => {
    if (prefillInput && isOpen) {
      setInput(prefillInput);
      setPrefillInput("");
      // Focus the input after a tick so the panel is visible
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [prefillInput, isOpen, setPrefillInput]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [isOpen]);

  // Load Optio settings (maxTurns, confirmWrites) on mount
  useEffect(() => {
    api
      .getOptioSettings()
      .then((res) => {
        const s = res.settings;
        if (s.maxTurns) setMaxTurns(s.maxTurns);
        if (s.confirmWrites !== undefined) setConfirmWrites(s.confirmWrites);
      })
      .catch(() => {});
  }, [setMaxTurns, setConfirmWrites]);

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        close();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, close]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Auto-scroll when messages change
  useEffect(() => {
    if (isOpen) {
      setTimeout(scrollToBottom, 50);
    }
  }, [messages, isOpen, scrollToBottom]);

  // Simulated message handling — in a real implementation this would connect
  // to WS /ws/optio/chat. For now we simulate responses to demonstrate the UI.
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || status === "thinking" || exchangeCount >= maxTurns) return;

    const userMsg: OptioChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    addMessage(userMsg);
    incrementExchange();
    setInput("");

    // Set thinking state
    setStatus("thinking");

    // Simulate assistant response
    setTimeout(() => {
      const isActionRequest =
        text.toLowerCase().includes("retry") ||
        text.toLowerCase().includes("update") ||
        text.toLowerCase().includes("cancel") ||
        text.toLowerCase().includes("change");

      if (isActionRequest) {
        const actionId = `action-${Date.now()}`;
        const actionItems = parseActionItems(text);
        const assistantMsg: OptioChatMessage = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: "I'd like to do the following:",
          timestamp: new Date().toISOString(),
          action: {
            id: actionId,
            description: "I'd like to do the following:",
            items: actionItems,
            decision: null,
          },
        };
        addMessage(assistantMsg);
      } else {
        const assistantMsg: OptioChatMessage = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: generateSimulatedResponse(text),
          timestamp: new Date().toISOString(),
        };
        addMessage(assistantMsg);
      }
      setStatus("ready");
    }, 1200);
  }, [input, status, exchangeCount, maxTurns, addMessage, incrementExchange, setStatus]);

  const handleApprove = useCallback(
    (actionId: string) => {
      const msg = messages.find((m) => m.action?.id === actionId);
      if (!msg) return;

      updateMessage(msg.id, {
        action: { ...msg.action!, decision: true },
      });

      // Simulate execution result
      setStatus("thinking");
      setTimeout(() => {
        addMessage({
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: "Done! All actions have been executed successfully.",
          timestamp: new Date().toISOString(),
        });
        setStatus("ready");
      }, 800);
    },
    [messages, updateMessage, addMessage, setStatus],
  );

  const handleDeny = useCallback(
    (actionId: string, feedback: string) => {
      const msg = messages.find((m) => m.action?.id === actionId);
      if (!msg) return;

      updateMessage(msg.id, {
        action: { ...msg.action!, decision: false },
      });

      // Add the user's denial feedback
      addMessage({
        id: `user-deny-${Date.now()}`,
        role: "user",
        content: feedback,
        timestamp: new Date().toISOString(),
        isDenialFeedback: true,
      });

      // Simulate revised plan
      setStatus("thinking");
      setTimeout(() => {
        addMessage({
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: `Got it. Let me revise the plan based on your feedback: "${feedback}"`,
          timestamp: new Date().toISOString(),
        });
        setStatus("ready");
      }, 1000);
    },
    [messages, updateMessage, addMessage, setStatus],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const atLimit = exchangeCount >= maxTurns;

  return (
    <>
      {/* Backdrop overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 md:bg-black/20 transition-opacity"
          onClick={close}
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        className={cn(
          "fixed inset-y-0 right-0 z-50 w-full md:w-[420px] flex flex-col",
          "bg-bg border-l border-border shadow-2xl",
          "transition-transform duration-300 ease-out",
          isOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-bg-card">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
              <OptioMark className="w-4 h-4 text-primary" />
            </div>
            <div>
              <span className="font-semibold text-sm text-text">Optio</span>
              <span className="block text-[10px] text-text-muted leading-none mt-0.5">
                AI Assistant
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={resetMessages}
              className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
              title="Reset conversation"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={close}
              className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Session reset notice */}
        <div className="shrink-0 px-4 py-1.5 border-b border-border/50 bg-bg-subtle">
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
            <Info className="w-3 h-3 shrink-0" />
            Session resets on page change
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {messages.length === 0 && (
            <div className="h-full flex items-center justify-center text-text-muted">
              <div className="text-center px-6">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <OptioMark className="w-6 h-6 text-primary/60" />
                </div>
                <p className="text-sm font-medium text-text mb-1">Ask Optio anything</p>
                <p className="text-xs text-text-muted max-w-[260px] mx-auto leading-relaxed">
                  Retry failed tasks, update repo settings, check status, or get help with your
                  workflow. Optio will ask for confirmation before taking action.
                </p>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id}>
              {msg.role === "user" ? (
                <div className="flex gap-2.5 justify-end">
                  <div className="max-w-[85%]">
                    <div
                      className={cn(
                        "rounded-lg px-3.5 py-2.5 text-sm whitespace-pre-wrap",
                        msg.isDenialFeedback
                          ? "bg-error/10 border border-error/20"
                          : "bg-primary/10 border border-primary/20",
                      )}
                    >
                      {msg.content}
                    </div>
                  </div>
                  <div className="shrink-0 mt-1">
                    <div className="w-6 h-6 rounded-full bg-bg-card border border-border flex items-center justify-center">
                      <User className="w-3.5 h-3.5 text-text-muted" />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2.5">
                  <div className="shrink-0 mt-1">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                      <OptioMark className="w-3.5 h-3.5 text-primary" />
                    </div>
                  </div>
                  <div className="max-w-[85%] min-w-0 space-y-2">
                    {msg.action ? (
                      <ActionCard
                        action={msg.action}
                        onApprove={handleApprove}
                        onDeny={handleDeny}
                      />
                    ) : (
                      <ChatMarkdown content={msg.content} />
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          {status === "thinking" && (
            <div className="flex gap-2.5">
              <div className="shrink-0 mt-1">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <OptioMark className="w-3.5 h-3.5 text-primary animate-pulse" />
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <Loader2 className="w-3 h-3 animate-spin" />
                Thinking...
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Exchange limit reached */}
        {atLimit && (
          <div className="shrink-0 px-4 py-3 border-t border-warning/20 bg-warning/5">
            <p className="text-xs text-warning mb-2">
              This conversation is getting long. Start a fresh one?
            </p>
            <button
              onClick={resetMessages}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors btn-press"
            >
              <RotateCcw className="w-3 h-3" />
              Reset conversation
            </button>
          </div>
        )}

        {/* Status: unavailable */}
        {status === "unavailable" && (
          <div className="shrink-0 px-4 py-3 border-t border-error/20 bg-error/5">
            <div className="flex items-center gap-2 text-xs text-error">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              Optio is currently unavailable. Please try again later.
            </div>
          </div>
        )}

        {/* Input area */}
        <div className="shrink-0 border-t border-border px-4 py-3 bg-bg-card">
          <div className="flex items-end gap-2">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  atLimit
                    ? "Conversation limit reached"
                    : status === "thinking"
                      ? "Optio is working..."
                      : status === "unavailable"
                        ? "Unavailable"
                        : "Ask Optio..."
                }
                disabled={status === "unavailable" || status === "thinking" || atLimit}
                rows={1}
                className={inputClass({
                  className:
                    "resize-none py-2.5 disabled:cursor-not-allowed min-h-[40px] max-h-[100px]",
                })}
                style={{ height: "auto" }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = "auto";
                  target.style.height = `${Math.min(target.scrollHeight, 100)}px`;
                }}
              />
            </div>
            <button
              onClick={handleSend}
              disabled={
                !input.trim() || status === "thinking" || status === "unavailable" || atLimit
              }
              className={cn(
                "shrink-0 p-2.5 rounded-lg transition-colors",
                input.trim() && status !== "thinking"
                  ? "bg-primary text-white hover:bg-primary-hover"
                  : "bg-bg-card text-text-muted border border-border",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
              title="Send (Enter)"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[10px] text-text-muted">
              Enter to send, Shift+Enter for new line
            </span>
            <span className="text-[10px] text-text-muted tabular-nums">
              {exchangeCount}/{maxTurns}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/** Parse user text to generate mock action items. */
function parseActionItems(text: string): string[] {
  const lower = text.toLowerCase();
  if (lower.includes("retry")) {
    return ["Retry failed tasks matching your criteria", "Monitor for successful completion"];
  }
  if (lower.includes("cancel")) {
    return ["Cancel the specified active tasks"];
  }
  if (lower.includes("update") || lower.includes("change")) {
    return ["Update the specified settings", "Apply changes immediately"];
  }
  return ["Perform the requested action"];
}

/** Generate a simulated response for demo purposes. */
function generateSimulatedResponse(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("status") || lower.includes("how")) {
    return "Here's a quick summary: check the dashboard for real-time task status, cluster health, and recent activity. You can also ask me to retry failed tasks or adjust settings.";
  }
  if (lower.includes("help")) {
    return "I can help you with:\n\n- Retrying failed tasks\n- Cancelling active tasks\n- Updating repo settings (concurrency, model, etc.)\n- Checking task and cluster status\n- Troubleshooting errors\n\nJust describe what you need and I'll propose a plan for your approval.";
  }
  if (lower.includes("fail") || lower.includes("error")) {
    return 'I can see some tasks have encountered issues. Would you like me to retry the failed ones? Just say "retry failed tasks" and I\'ll prepare an action plan for you.';
  }
  return "I understand your request. Let me know if you'd like me to take any specific actions — I'll always ask for your confirmation before making changes.";
}
