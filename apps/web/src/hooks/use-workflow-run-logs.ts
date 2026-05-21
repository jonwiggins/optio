"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api-client";
import { createWorkflowRunLogClient, type WsClient } from "@/lib/ws-client";
import { getWsTokenProvider } from "@/lib/ws-auth";
import type { LogEntry } from "@/hooks/use-logs";

const HISTORICAL_LIMIT = 10000;

/**
 * Hook to fetch historical + stream live workflow run logs via WebSocket.
 * Returns the same shape as useLogs so it can be used with LogViewer.
 */
export function useWorkflowRunLogs(runId: string, isActive: boolean) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [capped, setCapped] = useState(false);
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    if (!runId) return;

    // Buffer live events until historical logs are merged into state.
    const pendingLive: LogEntry[] = [];
    let merged = false;

    const client = createWorkflowRunLogClient(runId, getWsTokenProvider());
    clientRef.current = client;

    client.on("workflow_run:log", (event) => {
      // The WebSocket replays recent logs with `catchUp: true` on connect.
      // REST history is canonical, so ignore those replay frames.
      if (event.catchUp) return;

      const entry: LogEntry = {
        content: event.content,
        stream: event.stream,
        timestamp: event.timestamp,
        logType: event.logType,
        metadata: event.metadata,
      };
      if (!merged) {
        pendingLive.push(entry);
      } else {
        setLogs((prev) => {
          // Dedup: skip if the last entry has identical content and type
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
      }
    });

    if (isActive) {
      client.connect();
      setConnected(true);
    }

    api
      .getWorkflowRunLogs(runId, { limit: HISTORICAL_LIMIT })
      .then((res) => {
        const historical = res.logs.map((l: any) => ({
          content: l.content,
          stream: l.stream,
          timestamp: l.timestamp,
          logType: l.logType ?? undefined,
          metadata: l.metadata ?? undefined,
        }));
        if (historical.length >= HISTORICAL_LIMIT) setCapped(true);

        // Deduplicate: drop any live events already in the historical set
        const historicalKeys = new Set(historical.map((l: LogEntry) => l.timestamp + l.content));
        const uniqueLive = pendingLive.filter((l) => !historicalKeys.has(l.timestamp + l.content));

        setLogs([...historical, ...uniqueLive]);
        merged = true;
      })
      .catch(() => {
        setLogs(pendingLive);
        merged = true;
      });

    return () => {
      client.disconnect();
      setConnected(false);
    };
  }, [runId, isActive]);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, connected, capped, clear };
}
