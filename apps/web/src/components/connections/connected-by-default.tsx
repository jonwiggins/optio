"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { WorkEnvironmentEntry } from "@optio/shared";
import { api } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { ConnectedTo } from "./connected-to";
import { ConnectGallery } from "./connect-gallery";

/**
 * A repo's default connections, edited with the same picker work uses:
 * checking a connection assigns it to this repo, unchecking removes that
 * assignment. The organization's connections only — defaults are the
 * repo's, not one person's. A connection that is on for every repo (a
 * global assignment) can't be turned off for one repo here.
 */
export function ConnectedByDefault({ repoId }: { repoId: string }) {
  const { userId } = useCurrentUser();
  const [entries, setEntries] = useState<WorkEnvironmentEntry[] | null>(null);
  // connection id → the assignment covering this repo (`null` repoId = every repo)
  const [assigned, setAssigned] = useState<Map<string, { id: string; global: boolean }>>(new Map());
  const [gallery, setGallery] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ entries }, { connections }] = await Promise.all([
      api.listConnectionCatalog(),
      api.listRepoConnections(repoId),
    ]);
    setEntries(entries.filter((e) => e.kind === "connection" && !e.ownerUserId));
    const next = new Map<string, { id: string; global: boolean }>();
    await Promise.all(
      connections.map(async (c) => {
        const { assignments } = await api.listConnectionAssignments(c.id);
        const own = assignments.find((a) => a.repoId === repoId && a.enabled);
        const global = assignments.find((a) => a.repoId === null && a.enabled);
        const hit = own ?? global;
        if (hit) next.set(c.id, { id: hit.id, global: !own && !!global });
      }),
    );
    setAssigned(next);
  }, [repoId]);

  useEffect(() => {
    load().catch(() => setEntries([]));
  }, [load]);

  const toggle = useCallback(
    async (entry: WorkEnvironmentEntry, on: boolean) => {
      try {
        if (on) {
          await api.createConnectionAssignment(entry.id, { repoId, agentTypes: [] });
        } else {
          const hit = assigned.get(entry.id);
          if (hit) await api.deleteConnectionAssignment(hit.id);
        }
        await load();
      } catch (err) {
        toast.error(on ? "Couldn't connect" : "Couldn't disconnect", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [assigned, load, repoId],
  );

  useEffect(() => {
    if (!pending || !entries) return;
    const made = entries.find((e) => e.id === pending);
    if (made) {
      setPending(null);
      void toggle(made, true);
    }
  }, [pending, entries, toggle]);

  return (
    <>
      <ConnectedTo
        entries={entries}
        isOn={(e) => assigned.has(e.id)}
        onToggle={(e, on) => void toggle(e, on)}
        viewerId={userId}
        workOwner="workspace"
        hasRepo
        plain
        label="Connected by default"
        pickReason={(e) => {
          if (!e.enabled) return "Disabled — enable it under Library → Connections";
          if (assigned.get(e.id)?.global) {
            return "On for every repo — change that under Library → Connections";
          }
          return null;
        }}
        onConnectNew={() => setGallery(true)}
      />
      <p className="text-[11px] text-text-muted/80">
        Every agent on this repo gets these unless a piece of work turns one off. Review pods get
        tools without credentials.
      </p>
      <ConnectGallery
        open={gallery}
        onClose={() => setGallery(false)}
        defaultOwner="organization"
        onCreated={(made) => {
          setGallery(false);
          if (made.kind === "connection") setPending(made.id);
          void load();
        }}
      />
    </>
  );
}
