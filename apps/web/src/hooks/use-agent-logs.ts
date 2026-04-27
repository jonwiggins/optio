"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api-client";
import { createPersistentAgentEventsClient, type WsClient } from "@/lib/ws-client";
import { getWsTokenProvider } from "@/lib/ws-auth";
import type { LogEntry } from "@/hooks/use-logs";

const HISTORICAL_LIMIT = 10000;

/**
 * Live agent activity stream — WebSocket-only tail of an agent's log events.
 * Used for the "right now" view on the agent detail page. Returns the same
 * { logs, connected, capped, clear } shape as useLogs so it plugs into
 * LogViewer's externalLogs prop.
 *
 * Pass `currentTurnId` to filter to a single turn's events; omit to receive
 * everything the agent emits while the page is open.
 */
export function useAgentLiveLogs(agentId: string, currentTurnId?: string | null) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    if (!agentId) return;
    const client = createPersistentAgentEventsClient(agentId, getWsTokenProvider());
    clientRef.current = client;
    client.on("persistent_agent:log", (event: any) => {
      if (currentTurnId && event.turnId !== currentTurnId) return;
      setLogs((prev) => [
        ...prev,
        {
          content: event.content,
          stream: event.stream,
          timestamp: event.timestamp,
          logType: event.logType,
          metadata: event.metadata,
        },
      ]);
    });
    // Reset the buffer whenever a new turn starts so the live view is anchored
    // to the most recent turn rather than accumulating forever.
    client.on("persistent_agent:turn_started", () => {
      setLogs([]);
    });
    client.connect();
    setConnected(true);

    return () => {
      client.disconnect();
      clientRef.current = null;
      setConnected(false);
    };
  }, [agentId, currentTurnId]);

  const clear = useCallback(() => setLogs([]), []);
  return { logs, connected, capped: false, clear };
}

/**
 * Per-turn historical logs — REST fetch of one turn's logs. The turn endpoint
 * returns logs in chronological order; we adapt them to LogEntry shape so
 * LogViewer can render them with no special-casing.
 */
export function useAgentTurnLogs(agentId: string, turnId: string) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    if (!agentId || !turnId) return;
    let cancelled = false;
    api
      .getPersistentAgentTurn(agentId, turnId)
      .then((res) => {
        if (cancelled) return;
        const adapted: LogEntry[] = (res.logs ?? []).map((l: any) => ({
          content: l.content,
          stream: l.stream,
          timestamp: l.timestamp,
          logType: l.logType ?? undefined,
          metadata: l.metadata ?? undefined,
        }));
        if (adapted.length >= HISTORICAL_LIMIT) setCapped(true);
        setLogs(adapted.slice(0, HISTORICAL_LIMIT));
      })
      .catch(() => {
        // Show empty if fetch failed; LogViewer renders an empty state.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, turnId]);

  const clear = useCallback(() => setLogs([]), []);
  return { logs, connected: false, capped, clear };
}
