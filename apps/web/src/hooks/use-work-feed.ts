"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { WorkRow } from "@/lib/work-feed";

/**
 * Every piece of work Optio knows about (`GET /api/work`), polled while
 * mounted. Backs the Work list and the overview.
 */
export function useWorkFeed(opts: { pollMs?: number } = {}) {
  const [rows, setRows] = useState<WorkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const { rows } = await api.listWork();
      setRows(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load work");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refetch();
    }, opts.pollMs ?? 15_000);
    return () => clearInterval(interval);
  }, [refetch, opts.pollMs]);

  return { rows, loading, error, refetch };
}
