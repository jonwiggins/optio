"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  Send,
  Square,
  Bot,
  User,
  FileText,
  Terminal,
  Code,
  Search,
  Globe,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Loader2,
  Lightbulb,
} from "lucide-react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000";

interface ChatEvent {
  taskId: string;
  timestamp: string;
  sessionId?: string;
  type: "text" | "tool_use" | "tool_result" | "thinking" | "system" | "error" | "info";
  content: string;
  metadata?: Record<string, unknown>;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  events: ChatEvent[];
  costUsd?: number;
}

type ChatStatus = "connecting" | "ready" | "thinking" | "idle" | "error" | "disconnected";

interface SessionChatProps {
  sessionId: string;
  onCostUpdate?: (costUsd: number) => void;
  onSendToAgent?: (handler: (text: string) => void) => void;
}

export function SessionChat({ sessionId, onCostUpdate, onSendToAgent }: SessionChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<ChatStatus>("connecting");
  const [model, setModel] = useState<string>("sonnet");
  const [costUsd, setCostUsd] = useState(0);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const currentAssistantMsgRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Expose a handler for "send to agent" from the terminal
  const sendToAgent = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev}\n\n${text}` : text));
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    onSendToAgent?.(sendToAgent);
  }, [sendToAgent, onSendToAgent]);

  // WebSocket connection
  useEffect(() => {
    const ws = new WebSocket(`${WS_URL}/ws/sessions/${sessionId}/chat`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("ready");
    };

    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "status":
          setStatus(msg.status as ChatStatus);
          if (msg.model) setModel(msg.model);
          if (typeof msg.costUsd === "number") {
            setCostUsd(msg.costUsd);
            onCostUpdate?.(msg.costUsd);
          }
          break;

        case "chat_event": {
          const chatEvent = msg.event as ChatEvent;

          setMessages((prev) => {
            const msgs = [...prev];
            let currentMsgId = currentAssistantMsgRef.current;

            // Find or create the current assistant message
            if (!currentMsgId || !msgs.find((m) => m.id === currentMsgId)) {
              const newMsg: ChatMessage = {
                id: `assistant-${Date.now()}`,
                role: "assistant",
                content: "",
                timestamp: chatEvent.timestamp,
                events: [],
              };
              msgs.push(newMsg);
              currentMsgId = newMsg.id;
              currentAssistantMsgRef.current = currentMsgId;
            }

            const msgIdx = msgs.findIndex((m) => m.id === currentMsgId);
            if (msgIdx >= 0) {
              const updated = { ...msgs[msgIdx], events: [...msgs[msgIdx].events, chatEvent] };

              // Build content from text events
              if (chatEvent.type === "text") {
                updated.content = updated.events
                  .filter((e) => e.type === "text")
                  .map((e) => e.content)
                  .join("");
              }

              msgs[msgIdx] = updated;
            }

            return msgs;
          });

          setTimeout(scrollToBottom, 50);
          break;
        }

        case "cost_update":
          setCostUsd(msg.costUsd);
          onCostUpdate?.(msg.costUsd);
          break;

        case "error":
          // If there's a current assistant message, add the error to it
          setMessages((prev) => {
            const msgs = [...prev];
            const currentMsgId = currentAssistantMsgRef.current;
            if (currentMsgId) {
              const idx = msgs.findIndex((m) => m.id === currentMsgId);
              if (idx >= 0) {
                msgs[idx] = {
                  ...msgs[idx],
                  events: [
                    ...msgs[idx].events,
                    {
                      taskId: sessionId,
                      timestamp: new Date().toISOString(),
                      type: "error",
                      content: msg.message,
                    },
                  ],
                };
                return msgs;
              }
            }
            return msgs;
          });
          break;
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
    };

    ws.onerror = () => {
      setStatus("error");
    };

    return () => {
      ws.close();
    };
  }, [sessionId, onCostUpdate, scrollToBottom]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || !wsRef.current || status === "thinking") return;

    // Add user message
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
      events: [],
    };
    setMessages((prev) => [...prev, userMsg]);
    currentAssistantMsgRef.current = null;

    // Send to WebSocket
    wsRef.current.send(JSON.stringify({ type: "message", content: text }));
    setInput("");
    setTimeout(scrollToBottom, 50);
  };

  const handleInterrupt = () => {
    wsRef.current?.send(JSON.stringify({ type: "interrupt" }));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleToolExpand = (id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center text-text-muted">
            <div className="text-center">
              <Bot className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">Agent Chat</p>
              <p className="text-xs mt-1 max-w-xs">
                Ask the agent to write code, fix bugs, or explore the repository. It operates in the
                same worktree as your terminal.
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={cn("flex gap-3", msg.role === "user" ? "justify-end" : "")}>
            {msg.role === "assistant" && (
              <div className="shrink-0 mt-1">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5 text-primary" />
                </div>
              </div>
            )}

            <div
              className={cn(
                "max-w-[85%] rounded-lg",
                msg.role === "user"
                  ? "bg-primary/10 border border-primary/20 px-4 py-2.5"
                  : "space-y-2 min-w-0",
              )}
            >
              {msg.role === "user" ? (
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <AssistantMessage
                  msg={msg}
                  expandedTools={expandedTools}
                  onToggleTool={toggleToolExpand}
                />
              )}
            </div>

            {msg.role === "user" && (
              <div className="shrink-0 mt-1">
                <div className="w-6 h-6 rounded-full bg-bg-card border border-border flex items-center justify-center">
                  <User className="w-3.5 h-3.5 text-text-muted" />
                </div>
              </div>
            )}
          </div>
        ))}

        {status === "thinking" && (
          <div className="flex gap-3">
            <div className="shrink-0 mt-1">
              <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                <Bot className="w-3.5 h-3.5 text-primary animate-pulse" />
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

      {/* Input area */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                status === "thinking"
                  ? "Agent is working..."
                  : status === "disconnected"
                    ? "Disconnected"
                    : "Ask the agent..."
              }
              disabled={status === "disconnected" || status === "error"}
              rows={1}
              className={cn(
                "w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2.5 text-sm",
                "placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/50",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "min-h-[40px] max-h-[120px]",
              )}
              style={{ height: "auto" }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
              }}
            />
          </div>

          {status === "thinking" ? (
            <button
              onClick={handleInterrupt}
              className="shrink-0 p-2.5 rounded-lg bg-error/10 text-error hover:bg-error/20 transition-colors"
              title="Interrupt"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || status === "disconnected" || status === "error"}
              className={cn(
                "shrink-0 p-2.5 rounded-lg transition-colors",
                input.trim()
                  ? "bg-primary text-white hover:bg-primary/90"
                  : "bg-bg-card text-text-muted border border-border",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
              title="Send (Enter)"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[10px] text-text-muted">
            {status === "thinking"
              ? "Agent is working... Press Esc or click Stop to interrupt"
              : "Enter to send, Shift+Enter for new line"}
          </span>
          <span className="text-[10px] text-text-muted">{model}</span>
        </div>
      </div>
    </div>
  );
}

/** Render assistant message events (text, tool use, thinking, etc.) */
function AssistantMessage({
  msg,
  expandedTools,
  onToggleTool,
}: {
  msg: ChatMessage;
  expandedTools: Set<string>;
  onToggleTool: (id: string) => void;
}) {
  // Group events into renderable blocks
  const blocks: Array<{
    type: "text" | "tool_group" | "thinking" | "system" | "error" | "info";
    content: string;
    events: ChatEvent[];
    id: string;
  }> = [];

  let currentText = "";
  let currentToolGroup: ChatEvent[] = [];

  const flushText = () => {
    if (currentText.trim()) {
      blocks.push({ type: "text", content: currentText, events: [], id: `text-${blocks.length}` });
      currentText = "";
    }
  };

  const flushTools = () => {
    if (currentToolGroup.length > 0) {
      blocks.push({
        type: "tool_group",
        content: "",
        events: [...currentToolGroup],
        id: `tools-${blocks.length}`,
      });
      currentToolGroup = [];
    }
  };

  for (const event of msg.events) {
    switch (event.type) {
      case "text":
        flushTools();
        currentText += event.content;
        break;
      case "tool_use":
      case "tool_result":
        flushText();
        currentToolGroup.push(event);
        break;
      case "thinking":
        flushText();
        flushTools();
        blocks.push({
          type: "thinking",
          content: event.content,
          events: [event],
          id: `think-${blocks.length}`,
        });
        break;
      case "system":
      case "info":
        flushText();
        flushTools();
        blocks.push({
          type: event.type,
          content: event.content,
          events: [event],
          id: `${event.type}-${blocks.length}`,
        });
        break;
      case "error":
        flushText();
        flushTools();
        blocks.push({
          type: "error",
          content: event.content,
          events: [event],
          id: `error-${blocks.length}`,
        });
        break;
    }
  }
  flushText();
  flushTools();

  if (blocks.length === 0) return null;

  return (
    <>
      {blocks.map((block) => {
        switch (block.type) {
          case "text":
            return (
              <div key={block.id} className="text-sm whitespace-pre-wrap leading-relaxed">
                {block.content}
              </div>
            );

          case "tool_group":
            return (
              <div key={block.id} className="space-y-1">
                {block.events.map((ev, i) => {
                  const evId = `${block.id}-${i}`;
                  const isExpanded = expandedTools.has(evId);

                  if (ev.type === "tool_use") {
                    return (
                      <div
                        key={evId}
                        className="rounded-md border border-border/50 bg-bg-card/50 overflow-hidden"
                      >
                        <button
                          onClick={() => onToggleTool(evId)}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3 h-3 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3 h-3 shrink-0" />
                          )}
                          <ToolIcon toolName={ev.metadata?.toolName as string} />
                          <span className="truncate font-mono">{ev.content}</span>
                        </button>
                        {isExpanded && ev.metadata?.toolInput != null && (
                          <div className="px-3 pb-2 border-t border-border/30">
                            <pre className="text-[11px] text-text-muted overflow-x-auto mt-1.5">
                              {JSON.stringify(
                                ev.metadata.toolInput as Record<string, unknown>,
                                null,
                                2,
                              )}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // tool_result
                  if (ev.content.trim()) {
                    return (
                      <div
                        key={evId}
                        className="pl-7 text-[11px] text-text-muted font-mono truncate"
                        title={ev.content}
                      >
                        {ev.content.slice(0, 200)}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            );

          case "thinking":
            return (
              <div
                key={block.id}
                className="text-xs text-text-muted italic border-l-2 border-primary/20 pl-3 py-1"
              >
                <div className="flex items-center gap-1.5 mb-1 text-[10px] uppercase tracking-wider font-medium">
                  <Lightbulb className="w-3 h-3" />
                  Thinking
                </div>
                <span className="line-clamp-3">{block.content}</span>
              </div>
            );

          case "system":
          case "info":
            return (
              <div
                key={block.id}
                className="text-xs text-text-muted bg-bg-card/50 rounded px-3 py-1.5"
              >
                {block.content}
              </div>
            );

          case "error":
            return (
              <div
                key={block.id}
                className="text-xs text-error bg-error/5 border border-error/20 rounded px-3 py-1.5 flex items-start gap-2"
              >
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                {block.content}
              </div>
            );

          default:
            return null;
        }
      })}
    </>
  );
}

function ToolIcon({ toolName }: { toolName?: string }) {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return <FileText className="w-3 h-3 shrink-0" />;
    case "Bash":
      return <Terminal className="w-3 h-3 shrink-0" />;
    case "Glob":
    case "Grep":
      return <Search className="w-3 h-3 shrink-0" />;
    case "WebFetch":
    case "WebSearch":
      return <Globe className="w-3 h-3 shrink-0" />;
    default:
      return <Code className="w-3 h-3 shrink-0" />;
  }
}
