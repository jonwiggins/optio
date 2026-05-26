"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
import { getWsBaseUrl } from "@/lib/ws-client.js";
import { ANTHROPIC_CATALOG, GEMINI_CATALOG, resolveModelId } from "@optio/shared";
import { ChatMarkdown } from "./optio-chat/chat-markdown";

interface ChatEvent {
  taskId: string;
  timestamp: string;
  sessionId?: string;
  type:
    | "text"
    | "tool_use"
    | "tool_result"
    | "thinking"
    | "system"
    | "error"
    | "info"
    | "user_message";
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
  onModelUpdate?: (
    model: string,
    agentType: string,
    availableModels: { id: string; label: string }[],
  ) => void;
  onModelChange?: (handler: (model: string) => void) => void;
}

export function SessionChat({
  sessionId,
  onCostUpdate,
  onSendToAgent,
  onModelUpdate,
  onModelChange,
}: SessionChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<ChatStatus>("connecting");
  const [model, setModel] = useState<string>("sonnet");
  const [agentType, setAgentType] = useState<string>("claude-code");
  const [costUsd, setCostUsd] = useState(0);

  const [showSystemLogs, setShowSystemLogs] = useState(true);
  const [showThinkingLogs, setShowThinkingLogs] = useState(true);
  const [showToolLogs, setShowToolLogs] = useState(true);

  // WebSocket connection
  const wsRef = useRef<WebSocket | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Terminal can route highlighted text into our composer.
  const sendToAgent = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev}\n\n${text}` : text));
    textareaRef.current?.focus();
  }, []);
  useEffect(() => {
    onSendToAgent?.(sendToAgent);
  }, [sendToAgent, onSendToAgent]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Expose a handler for external model changes (from header dropdown)
  const handleModelChange = useCallback((newModel: string) => {
    setModel(newModel);
    if (wsRef.current && wsRef.current.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: "set_model", model: newModel }));
    }
  }, []);

  useEffect(() => {
    onModelChange?.(handleModelChange);
  }, [handleModelChange, onModelChange]);

  // Compute model options based on agent type
  const modelOptions = useMemo(() => {
    const catalog = agentType === "gemini" ? GEMINI_CATALOG : ANTHROPIC_CATALOG;
    return catalog.models.map((m) => ({
      id: m.id,
      label: m.label,
      latest: m.latest,
      preview: m.preview,
    }));
  }, [agentType]);

  // Validate model when agentType changes - ensure model matches agent type
  useEffect(() => {
    const isValidModel = modelOptions.some((m) => m.id === model);

    if (!isValidModel) {
      const defaultModel = agentType === "gemini" ? "gemini-2.5-flash" : "sonnet";
      setModel(defaultModel);
      if (wsRef.current && wsRef.current.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: "set_model", model: defaultModel }));
      }
    }
  }, [agentType, model, modelOptions]);

  // Notify parent when model/agentType/modelOptions change
  useEffect(() => {
    if (model && agentType && modelOptions.length > 0) {
      onModelUpdate?.(model, agentType, modelOptions);
    }
  }, [model, agentType, modelOptions, onModelUpdate]);

  // WebSocket connection
  useEffect(() => {
    const ws = new WebSocket(`${getWsBaseUrl()}/ws/sessions/${sessionId}/chat`);
    wsRef.current = ws;

    ws.onopen = () => setStatus("ready");
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
          if (msg.agentType) setAgentType(msg.agentType);
          if (typeof msg.costUsd === "number") {
            setCostUsd(msg.costUsd);
            onCostUpdate?.(msg.costUsd);
          }
          break;

        case "chat_event": {
          const chatEvent = msg.event as ChatEvent;

          if (chatEvent.type === "user_message") {
            setMessages((prev) => {
              // Avoid duplicates if already added locally
              if (
                prev.some(
                  (m) =>
                    m.content === chatEvent.content &&
                    m.role === "user" &&
                    Math.abs(
                      new Date(m.timestamp).getTime() - new Date(chatEvent.timestamp).getTime(),
                    ) < 10000,
                )
              ) {
                return prev;
              }
              return [
                ...prev,
                {
                  id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  role: "user",
                  content: chatEvent.content,
                  timestamp: chatEvent.timestamp,
                  events: [chatEvent],
                },
              ];
            });
            break;
          }

          setMessages((prev) => {
            const msgs = [...prev];
            const lastMsg = msgs[msgs.length - 1];

            if (!lastMsg || lastMsg.role !== "assistant") {
              const newMsg: ChatMessage = {
                id: `assistant-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                role: "assistant",
                content: "",
                timestamp: chatEvent.timestamp,
                events: [chatEvent],
              };
              if (chatEvent.type === "text") {
                newMsg.content = chatEvent.content;
              }
              msgs.push(newMsg);
            } else {
              const updated = { ...lastMsg, events: [...lastMsg.events, chatEvent] };
              if (chatEvent.type === "text") {
                updated.content = updated.events
                  .filter((e) => e.type === "text")
                  .map((e) => e.content)
                  .join("");
              }
              msgs[msgs.length - 1] = updated;
            }
            return msgs;
          });
          break;
        }

        case "cost_update":
          setCostUsd(msg.costUsd);
          onCostUpdate?.(msg.costUsd);
          break;
      }
    };

    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("error");

    return () => {
      ws.close();
    };
  }, [sessionId, onCostUpdate]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || status === "thinking") return;
    if (wsRef.current && wsRef.current.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: "message", text, content: text }));

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        events: [
          {
            taskId: sessionId,
            timestamp: new Date().toISOString(),
            type: "text",
            content: text,
          },
        ],
      };
      setMessages((prev) => [...prev, userMsg]);
    }
    setInput("");
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
  };

  const handleInterrupt = () => {
    if (wsRef.current && wsRef.current.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {messages.map((m) => (
          <div key={m.id} className="mb-4">
            <div className="font-bold text-xs uppercase text-text-muted mb-1">{m.role}</div>
            <div className="space-y-2">
              {m.events && m.events.length > 0 ? (
                m.events.map((e, idx) => {
                  if (e.type === "text" || e.type === "user_message") {
                    return <ChatMarkdown key={idx} content={e.content} />;
                  }
                  if (e.type === "error") {
                    return (
                      <div
                        key={idx}
                        className="flex gap-2 items-start text-xs text-error bg-error/10 p-2.5 rounded-md border border-error/20 my-1 font-mono"
                      >
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <div className="whitespace-pre-wrap">{e.content}</div>
                      </div>
                    );
                  }
                  if (e.type === "system" || e.type === "info") {
                    if (!showSystemLogs) return null;
                    return (
                      <div
                        key={idx}
                        className="text-xs text-text-muted bg-bg-card p-2 rounded border border-border/50 my-1 font-mono flex items-center gap-1.5"
                      >
                        <Bot className="w-3.5 h-3.5 text-primary" />
                        <div>{e.content}</div>
                      </div>
                    );
                  }
                  if (e.type === "tool_use") {
                    if (!showToolLogs) return null;
                    return (
                      <div
                        key={idx}
                        className="text-xs text-text-muted bg-bg-card border border-border rounded my-1 font-mono"
                      >
                        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border/50 bg-bg/50">
                          <Code className="w-3.5 h-3.5 text-primary" />
                          <span className="font-bold">Executing Tool:</span>
                          <span>{(e.metadata?.toolName as string) || "unknown"}</span>
                        </div>
                        {e.content && (
                          <pre className="p-2.5 overflow-x-auto max-h-40 text-[11px] bg-bg/30 text-text/90 whitespace-pre-wrap leading-relaxed">
                            {e.content}
                          </pre>
                        )}
                      </div>
                    );
                  }
                  if (e.type === "tool_result") {
                    if (!showToolLogs) return null;
                    return (
                      <div
                        key={idx}
                        className="text-xs text-text-muted/80 bg-bg-card border border-border/50 rounded my-1 font-mono opacity-80"
                      >
                        <div className="flex items-center gap-1.5 px-2.5 py-1 border-b border-border/30 bg-bg/20">
                          <Terminal className="w-3.5 h-3.5 text-text-muted" />
                          <span>Tool Result</span>
                        </div>
                        <pre className="p-2.5 overflow-x-auto max-h-40 text-[11px] bg-bg/20 text-text-muted whitespace-pre-wrap leading-relaxed">
                          {e.content}
                        </pre>
                      </div>
                    );
                  }
                  if (e.type === "thinking") {
                    if (!showThinkingLogs) return null;
                    return (
                      <div
                        key={idx}
                        className="text-xs text-text-muted font-mono flex items-center gap-2 py-1"
                      >
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                        <span>{e.content || "Thinking..."}</span>
                      </div>
                    );
                  }
                  return null;
                })
              ) : (
                <ChatMarkdown content={m.content} />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Log Toggles Row */}
      <div className="flex items-center gap-1.5 px-4 pt-2 pb-1">
        <span className="text-[10px] text-primary font-bold uppercase tracking-wider select-none">
          Show Logs:
        </span>
        <div className="w-px h-3 bg-border/40 mx-0.5" />
        <button
          onClick={() => setShowSystemLogs(!showSystemLogs)}
          className={cn(
            "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border",
            showSystemLogs
              ? "bg-primary/10 text-primary border-primary/20"
              : "bg-transparent text-text-muted border-transparent hover:text-text hover:bg-bg-hover",
          )}
          title="Show or hide system and run summary logs"
        >
          System
        </button>
        <button
          onClick={() => setShowThinkingLogs(!showThinkingLogs)}
          className={cn(
            "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border",
            showThinkingLogs
              ? "bg-primary/10 text-primary border-primary/20"
              : "bg-transparent text-text-muted border-transparent hover:text-text hover:bg-bg-hover",
          )}
          title="Show or hide agent thinking/reasoning logs"
        >
          Thinking
        </button>
        <button
          onClick={() => setShowToolLogs(!showToolLogs)}
          className={cn(
            "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors border",
            showToolLogs
              ? "bg-primary/10 text-primary border-primary/20"
              : "bg-transparent text-text-muted border-transparent hover:text-text hover:bg-bg-hover",
          )}
          title="Show or hide tool calls and results"
        >
          Tools
        </button>
      </div>

      <div className="flex items-end gap-2 p-4">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={handleKeyDown}
          disabled={status === "disconnected" || status === "error"}
          placeholder={
            status === "thinking"
              ? "Agent is working…"
              : status === "disconnected"
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
      <div className="flex items-center justify-between px-4 pb-2">
        <span className="text-[10px] text-text-muted">
          {status === "thinking"
            ? "Agent is working... Press Esc or click Stop to interrupt"
            : "Enter to send, Shift+Enter for new line"}
        </span>
        <span className="text-[10px] text-text-muted/50 uppercase tracking-wider font-mono">
          {agentType}
        </span>
      </div>
    </div>
  );
}
