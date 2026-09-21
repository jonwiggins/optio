"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { collectWork, type WorkRow } from "@/lib/work-feed";

/**
 * Every piece of work Optio knows about, merged from the per-kind endpoints and
 * polled while mounted. Backs the Sessions list and the overview.
 */
export function useWorkFeed(opts: { pollMs?: number } = {}) {
  const [rows, setRows] = useState<WorkRow[]>([]);
  const [hosts, setHosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const settle = <T>(p: Promise<T>, empty: T) => p.catch(() => empty);
    try {
      const [unified, terminals, blueprints, sessions, agents, hostList] = await Promise.all([
        settle(api.listTasksUnified({ type: "all", limit: 200 }), {
          tasks: [] as any[],
          limit: 0,
          offset: 0,
        }),
        settle(api.listLocalTerminals(), { terminals: [] as any[] }),
        settle(api.listLocalBlueprints(), { blueprints: [] as any[] }),
        settle(api.listSessions({ limit: 100 }), { sessions: [] as any[], activeCount: 0 }),
        settle(api.listPersistentAgents(), { agents: [] as any[] }),
        settle(api.listLocalHosts(), { hosts: [] as any[] }),
      ]);
      setHosts(hostList.hosts);
      setRows(
        collectWork({
          unified: unified.tasks,
          localTerminals: terminals.terminals,
          localBlueprints: blueprints.blueprints,
          podSessions: sessions.sessions,
          agents: agents.agents,
          hosts: hostList.hosts,
        }),
      );
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

  return { rows, hosts, loading, error, refetch };
}
