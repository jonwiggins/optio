"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api-client";
import { createPrReviewLogClient, type WsClient } from "@/lib/ws-client";
import { getWsTokenProvider } from "@/lib/ws-auth";
import type { LogEntry } from "./use-logs";

const HISTORICAL_LIMIT = 10000;

/**
 * Mirror of `useLogs` for PR reviews. Returns the same `{ logs, connected,
 * capped, clear }` shape so it can be passed straight into `<LogViewer>` via
 * the `externalLogs` prop.
 *
 * Logs live in `task_logs` keyed by `pr_review_run_id`. The hook:
 *   1. Opens a WS to `/ws/pr-reviews/:id/logs` for live tailing
 *   2. Fetches historical logs for the latest run via REST
 *   3. Dedupes on `timestamp + content`
 */
export function usePrReviewLogs(prReviewId: string) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [capped, setCapped] = useState(false);
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    if (!prReviewId) return;

    const pendingLive: LogEntry[] = [];
    let merged = false;

    const client = createPrReviewLogClient(prReviewId, getWsTokenProvider());
    clientRef.current = client;

    client.on("pr_review_run:log", (event) => {
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
      .listPrReviewLogs(prReviewId)
      .then((res) => {
        const historical: LogEntry[] = res.logs.map((l: any) => ({
          content: l.content,
          stream: l.stream,
          timestamp: l.timestamp,
          logType: l.logType ?? undefined,
          metadata: l.metadata ?? undefined,
        }));
        if (historical.length >= HISTORICAL_LIMIT) setCapped(true);

        const historicalKeys = new Set(historical.map((l) => l.timestamp + l.content));
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
  }, [prReviewId]);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, connected, capped, clear };
}
