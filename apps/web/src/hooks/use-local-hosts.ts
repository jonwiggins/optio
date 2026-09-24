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

  /**
   * Take a host row an API call just returned (e.g. after adding a
   * directory) without waiting for the next poll, so a selection made in
   * the same breath finds it.
   */
  const replaceHost = useCallback((host: any) => {
    setHosts((prev) => prev.map((h) => (h.id === host.id ? { ...h, ...host } : h)));
  }, []);

  useEffect(() => {
    refetch();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refetch();
    }, opts.pollMs ?? 15_000);
    return () => clearInterval(interval);
  }, [refetch, opts.pollMs]);

  return { hosts, loading, refetch, replaceHost };
}
