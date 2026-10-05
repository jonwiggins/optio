"use client";

import { useEffect, useState } from "react";
import type { WorkEnvironmentEntry, WorkSettings } from "@optio/shared";
import { api } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { ConnectionMark } from "@/components/connection-mark";
import { entrySubtext } from "@/lib/connections";

/**
 * What a piece of saved work is connected to, read-only: the catalog for
 * its repo and runtime, with its own settings and pod secrets applied. The
 * agent page's Config tab shows it; editing stays in the work form.
 */
export function ConnectedSummary({
  repoUrl,
  agentType,
  ownerUserId,
  settings,
  podSecrets,
}: {
  repoUrl: string | null;
  agentType: string;
  ownerUserId: string | null;
  settings: WorkSettings | null | undefined;
  podSecrets: string[] | null | undefined;
}) {
  const { userId } = useCurrentUser();
  const [entries, setEntries] = useState<WorkEnvironmentEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getWorkEnvironment({ repoUrl, agentType, owner: ownerUserId ? "me" : "workspace" })
      .then((o) => live && setEntries(o.catalog))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [repoUrl, agentType, ownerUserId]);

  const on = (e: WorkEnvironmentEntry) => {
    if (e.kind === "secret") return (podSecrets ?? []).includes(e.id);
    const o = e.kind === "connection" ? settings?.connections : settings?.mcpServers;
    return e.default ? !(o?.remove ?? []).includes(e.id) : (o?.add ?? []).includes(e.id);
  };
  const connected = entries?.filter(on) ?? [];

  return (
    <div className="space-y-1.5" data-testid="connected-summary">
      <div className="text-xs text-text-muted">Connected to</div>
      {entries === null ? (
        <p className="text-[11px] text-text-muted/60">Loading…</p>
      ) : connected.length === 0 ? (
        <p className="text-[11px] text-text-muted/80">Nothing connected.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {connected.map((e) => (
            <span
              key={`${e.kind}:${e.id}`}
              className="inline-flex items-center gap-1.5 h-7 pl-1 pr-2 rounded-md border border-primary/40 bg-primary/10 text-xs text-text"
              title={entrySubtext(e, userId)}
            >
              <ConnectionMark icon={e.icon} kind={e.kind} size="sm" />
              {e.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
