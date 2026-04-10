"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api-client";
import { createLogClient, type WsClient } from "@/lib/ws-client";
import { getWsTokenProvider } from "@/lib/ws-auth";

export interface LogEntry {
  content: string;
  stream: string;
  timestamp: string;
  logType?: string;
  metadata?: Record<string, unknown>;
}

const HISTORICAL_LIMIT = 10000;

export function useLogs(taskId: string) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [capped, setCapped] = useState(false);
  const clientRef = useRef<WsClient | null>(null);
  const historicalCountRef = useRef(0);

  // Load historical logs, then connect WebSocket for live streaming
  useEffect(() => {
    if (!taskId) return;

    // Buffer live events until historical logs are merged into state.
    // `merged` flips to true only AFTER setLogs is called with historical data,
    // closing the race where live events bypass dedup.
    const pendingLive: LogEntry[] = [];
    let merged = false;

    const client = createLogClient(taskId, getWsTokenProvider());
    clientRef.current = client;

    client.on("task:log", (event) => {
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

    client.connect();
    setConnected(true);

    api
      .getTaskLogs(taskId, { limit: HISTORICAL_LIMIT })
      .then((res) => {
        const historical = res.logs.map((l: any) => ({
          content: l.content,
          stream: l.stream,
          timestamp: l.timestamp,
          logType: l.logType ?? undefined,
          metadata: l.metadata ?? undefined,
        }));
        historicalCountRef.current = historical.length;
        if (historical.length >= HISTORICAL_LIMIT) setCapped(true);

        // Deduplicate: drop any live events already in the historical set
        const historicalKeys = new Set(historical.map((l: LogEntry) => l.timestamp + l.content));
        const uniqueLive = pendingLive.filter((l) => !historicalKeys.has(l.timestamp + l.content));

        setLogs([...historical, ...uniqueLive]);
        // Only NOW let live events flow directly — historical merge is done
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
  }, [taskId]);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, connected, capped, clear };
}
