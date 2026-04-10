"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api-client";
import type { LogEntry } from "@/hooks/use-logs";

const HISTORICAL_LIMIT = 10000;
const POLL_INTERVAL = 3000;

/**
 * Hook to fetch and poll workflow run logs.
 * Returns the same shape as useLogs so it can be used with LogViewer.
 */
export function useWorkflowRunLogs(runId: string, isActive: boolean) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [capped, setCapped] = useState(false);
  const lastCountRef = useRef(0);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await api.getWorkflowRunLogs(runId, { limit: HISTORICAL_LIMIT });
      const entries: LogEntry[] = res.logs.map((l: any) => ({
        content: l.content,
        stream: l.stream,
        timestamp: l.timestamp,
        logType: l.logType ?? undefined,
        metadata: l.metadata ?? undefined,
      }));
      lastCountRef.current = entries.length;
      if (entries.length >= HISTORICAL_LIMIT) setCapped(true);
      setLogs(entries);
    } catch {
      // Keep existing logs on error
    } finally {
      setLoading(false);
    }
  }, [runId]);

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    fetchLogs();
  }, [fetchLogs]);

  // Poll while active
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(fetchLogs, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [isActive, fetchLogs]);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, connected: isActive, capped, clear, loading };
}
