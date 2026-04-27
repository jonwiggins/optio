"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api-client";
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

const HISTORICAL_LIMIT = 5000;

/**
 * Adapter hook: opens the session chat WebSocket, normalizes its events into
 * the same { logs, connected, capped, clear } shape that LogViewer's
 * externalLogs prop expects, plus exposes the session-specific affordances
 * (sendMessage, interrupt, status, model, cost, userMessages) that the
 * surrounding chat shell needs.
 *
 * Loads persisted chat history from `GET /api/sessions/:id/chat` first, then
 * connects the WebSocket for live tail. Live events that arrive before
 * history resolves are buffered and deduplicated against history on merge —
 * mirrors the pattern used by `useLogs` and `useWorkflowRunLogs`.
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
  const [capped, setCapped] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const onCostUpdateRef = useRef(opts.onCostUpdate);
  onCostUpdateRef.current = opts.onCostUpdate;

  useEffect(() => {
    if (!sessionId) return;

    // Buffer live events until historical chat is merged into state. `merged`
    // flips to true only AFTER setLogs is called with historical data,
    // closing the race where live events bypass dedup.
    const pendingLive: LogEntry[] = [];
    let merged = false;

    const ws = new WebSocket(`${getWsBaseUrl()}/ws/sessions/${sessionId}/chat`);
    wsRef.current = ws;

    const appendLive = (entry: LogEntry) => {
      if (!merged) {
        pendingLive.push(entry);
        return;
      }
      setLogs((prev) => {
        // Dedup: skip if the last entry has identical content + type + timestamp
        const last = prev[prev.length - 1];
        if (
          last &&
          last.content === entry.content &&
          last.logType === entry.logType &&
          last.timestamp === entry.timestamp
        ) {
          return prev;
        }
        return [...prev, entry];
      });
    };

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
          // The WebSocket replays history with `catchUp: true` on connect.
          // We rely on REST for the canonical history load and ignore the
          // catch-up frames so they don't double up after dedup.
          if (msg.catchUp) return;
          appendLive(entry);
          break;
        }
        case "cost_update":
          if (typeof msg.costUsd === "number") {
            setCostUsd(msg.costUsd);
            onCostUpdateRef.current?.(msg.costUsd);
          }
          break;
        case "error":
          appendLive({
            content: msg.message ?? "Unknown error",
            stream: "stderr",
            timestamp: new Date().toISOString(),
            logType: "error",
          });
          break;
      }
    };

    api
      .getSessionChat(sessionId, { limit: HISTORICAL_LIMIT })
      .then((res) => {
        const historical: LogEntry[] = res.events.map((e: any) => ({
          content: e.content,
          stream: e.stream ?? "stdout",
          timestamp:
            typeof e.timestamp === "string" ? e.timestamp : new Date(e.timestamp).toISOString(),
          logType: e.logType ?? undefined,
          metadata: e.metadata ?? undefined,
        }));
        // Surface user-typed messages in the dedicated chat input timeline so
        // the user's side of the conversation re-renders on reconnect.
        const restoredUserMessages = historical
          .filter((l) => l.logType === "user_message")
          .map((l) => ({ text: l.content, timestamp: l.timestamp, status: "sent" as const }));
        if (restoredUserMessages.length > 0) {
          setUserMessages((prev) =>
            prev.length === 0 ? restoredUserMessages : [...restoredUserMessages, ...prev],
          );
        }
        if (historical.length >= HISTORICAL_LIMIT) setCapped(true);

        // Drop user_message rows from the log timeline — they're surfaced
        // separately above via userMessages, just like a fresh in-tab session.
        const agentHistorical = historical.filter((l) => l.logType !== "user_message");

        // Deduplicate: drop any live events already in the historical set
        const historicalKeys = new Set(
          agentHistorical.map((l: LogEntry) => l.timestamp + l.content),
        );
        const uniqueLive = pendingLive.filter((l) => !historicalKeys.has(l.timestamp + l.content));

        setLogs([...agentHistorical, ...uniqueLive]);
        merged = true;
      })
      .catch(() => {
        setLogs(pendingLive);
        merged = true;
      });

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
    capped,
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
