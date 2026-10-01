"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { collectWork, type WorkRow, type WorkSources } from "@/lib/work-feed";

type TriggerList = NonNullable<WorkSources["triggers"]>[string];

/** The triggers of one recurring definition, by the endpoint its kind uses. */
function fetchTriggers(row: WorkRow, id: string): Promise<TriggerList> {
  const req =
    row.source === "local-blueprint"
      ? api.listLocalBlueprintTriggers(id)
      : api.listTaskTriggers(id);
  return req.then((r) => r.triggers ?? []);
}

/**
 * Every piece of work Optio knows about, merged from the per-kind endpoints and
 * polled while mounted. Backs the Sessions list and the overview.
 */
export function useWorkFeed(opts: { pollMs?: number } = {}) {
  const [rows, setRows] = useState<WorkRow[]>([]);
  const [hosts, setHosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Triggers per recurring definition, fetched once per definition while
  // mounted (the list endpoints don't carry them) so rows can show what
  // starts them — GitHub, Slack, Linear, a schedule, …
  const triggerCache = useRef(new Map<string, TriggerList>());
  const triggerInflight = useRef(new Set<string>());

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
      const sources: WorkSources = {
        unified: unified.tasks,
        localTerminals: terminals.terminals,
        localBlueprints: blueprints.blueprints,
        podSessions: sessions.sessions,
        agents: agents.agents,
        hosts: hostList.hosts,
      };
      const collect = () =>
        collectWork({ ...sources, triggers: Object.fromEntries(triggerCache.current) });
      const collected = collect();
      setRows(collected);
      setError(null);

      const missing = collected.filter((r) => {
        if (!r.recurring) return false;
        const id = definitionId(r);
        return !triggerCache.current.has(id) && !triggerInflight.current.has(id);
      });
      if (missing.length > 0) {
        await Promise.all(
          missing.map(async (r) => {
            const id = definitionId(r);
            triggerInflight.current.add(id);
            try {
              triggerCache.current.set(id, await fetchTriggers(r, id));
            } catch {
              // Leave it out; the row says "on a trigger" and a later poll retries.
            } finally {
              triggerInflight.current.delete(id);
            }
          }),
        );
        setRows(collect());
      }
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

/** A recurring row's definition id (`blueprint-<id>`, `job-<id>`, `automation-<id>`). */
function definitionId(row: WorkRow): string {
  return row.key.slice(row.key.indexOf("-") + 1);
}
