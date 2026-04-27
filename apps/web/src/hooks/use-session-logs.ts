"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getWsBaseUrl } from "@/lib/ws-client.js";
import type { LogEntry } from "@/hooks/use-logs";
import type { UserMessage } from "@/components/log-viewer";

export type SessionStatus = "connecting" | "ready" | "thinking" | "idle" | "error" | "disconnected";

interface ChatEventWire {
  taskId: string;
  timestamp: string;
  sessionId?: string;
  type: "text" | "tool_use" | "tool_result" | "thinking" | "system" | "error" | "info";
  content: string;
  metadata?: Record<string, unknown>;
}

interface UseSessionLogsOpts {
  onCostUpdate?: (costUsd: number) => void;
}

/**
 * Adapter hook: opens the session chat WebSocket, normalizes its events into
 * the same { logs, connected, capped, clear } shape that LogViewer's
 * externalLogs prop expects, plus exposes the session-specific affordances
 * (sendMessage, interrupt, status, model, cost, userMessages) that the
 * surrounding chat shell needs.
 *
 * One ChatEvent maps to one LogEntry, so LogViewer's full grouping / search /
 * filter / time-gap rendering works for sessions with no special-casing.
 */
export function useSessionLogs(sessionId: string, opts: UseSessionLogsOpts = {}) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [userMessages, setUserMessages] = useState<UserMessage[]>([]);
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [model, setModelState] = useState<string>("sonnet");
  const [costUsd, setCostUsd] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const onCostUpdateRef = useRef(opts.onCostUpdate);
  onCostUpdateRef.current = opts.onCostUpdate;

  useEffect(() => {
    if (!sessionId) return;
    const ws = new WebSocket(`${getWsBaseUrl()}/ws/sessions/${sessionId}/chat`);
    wsRef.current = ws;

    ws.onopen = () => setStatus("ready");
    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("error");

    ws.onmessage = (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "status":
          setStatus(msg.status as SessionStatus);
          if (msg.model) setModelState(msg.model);
          if (typeof msg.costUsd === "number") {
            setCostUsd(msg.costUsd);
            onCostUpdateRef.current?.(msg.costUsd);
          }
          break;
        case "chat_event": {
          const ev = msg.event as ChatEventWire;
          const entry: LogEntry = {
            content: ev.content,
            stream: "stdout",
            timestamp: ev.timestamp,
            logType: ev.type,
            metadata: ev.metadata,
          };
          setLogs((prev) => [...prev, entry]);
          break;
        }
        case "cost_update":
          if (typeof msg.costUsd === "number") {
            setCostUsd(msg.costUsd);
            onCostUpdateRef.current?.(msg.costUsd);
          }
          break;
        case "error":
          setLogs((prev) => [
            ...prev,
            {
              content: msg.message ?? "Unknown error",
              stream: "stderr",
              timestamp: new Date().toISOString(),
              logType: "error",
            },
          ]);
          break;
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const ts = new Date().toISOString();
    setUserMessages((prev) => [...prev, { text: trimmed, timestamp: ts, status: "sent" }]);
    ws.send(JSON.stringify({ type: "message", content: trimmed }));
  }, []);

  const interrupt = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  const setModel = useCallback((next: string) => {
    setModelState(next);
    wsRef.current?.send(JSON.stringify({ type: "set_model", model: next }));
  }, []);

  const clear = useCallback(() => {
    setLogs([]);
    setUserMessages([]);
  }, []);

  return {
    logs,
    connected: status === "ready" || status === "thinking" || status === "idle",
    capped: false,
    clear,
    userMessages,
    sendMessage,
    interrupt,
    status,
    model,
    setModel,
    costUsd,
  };
}
