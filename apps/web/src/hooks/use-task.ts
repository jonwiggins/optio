"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";

export function useTask(id: string) {
  const [task, setTask] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [pendingReason, setPendingReason] = useState<string | null>(null);
  const [pipelineProgress, setPipelineProgress] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [taskRes, eventsRes] = await Promise.all([api.getTask(id), api.getTaskEvents(id)]);
      setTask(taskRes.task);
      setPendingReason(taskRes.pendingReason ?? null);
      setPipelineProgress(taskRes.pipelineProgress ?? null);
      setEvents(eventsRes.events);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load task");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { task, events, pendingReason, pipelineProgress, loading, error, refresh };
}
