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

  // WebSocket connection
  const wsRef = useRef<WebSocket | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentAssistantMsgRef = useRef<string | null>(null);

  // Terminal can route highlighted text into our composer.
  const sendToAgent = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev}\n\n${text}` : text));
    textareaRef.current?.focus();
  }, []);
  useEffect(() => {
    onSendToAgent?.(sendToAgent);
  }, [sendToAgent, onSendToAgent]);

  // Expose a handler for external model changes (from header dropdown)
  const handleModelChange = useCallback((newModel: string) => {
    setModel(newModel);
    wsRef.current?.send(JSON.stringify({ type: "set_model", model: newModel }));
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
      wsRef.current?.send(JSON.stringify({ type: "set_model", model: defaultModel }));
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
          setMessages((prev) => {
            const msgs = [...prev];
            let currentMsgId = currentAssistantMsgRef.current;
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
    wsRef.current?.send(JSON.stringify({ type: "message", text }));
    setInput("");
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
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

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((m) => (
          <div key={m.id} className="mb-4">
            <div className="font-bold text-xs uppercase text-text-muted mb-1">{m.role}</div>
            <div className="text-sm">{m.content}</div>
          </div>
        ))}
      </div>

      <div className="flex items-end gap-2 p-4 border-t border-border">
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
        <span className="text-[10px] text-text-muted/50">{agentType}</span>
      </div>
    </div>
  );
}
