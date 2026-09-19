"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";

/**
 * The caller's paired Optio Local hosts (machines running `optio local up`),
 * for anything that lets the user pick "run this on my machine". Polls
 * while mounted so a host that comes online mid-form shows up.
 */
export function useLocalHosts(opts: { pollMs?: number } = {}) {
  const [hosts, setHosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await api.listLocalHosts();
      setHosts(res.hosts);
    } catch {
      // Local may be unavailable (no daemon ever paired); the picker copes.
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

  return { hosts, loading, refetch };
}
