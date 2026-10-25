"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Boxes, Square } from "lucide-react";
import { REMOTE_WORKSPACE_PROVIDER_INFO, isRemoteWorkspaceProvider } from "@optio/shared";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { providerLabel, sortConnections } from "./location";

/**
 * A machine that is a remote workspace Optio started (`origin` = its
 * provider, docs/remote-workspaces.md), as the Machines page shows it: a
 * badge with the provider and the workspace's name, and "Stop workspace".
 */

interface WorkspaceHost {
  name: string;
  origin?: string;
  remoteWorkspaceId?: string | null;
  remoteWorkspaceName?: string | null;
  /** Not in every server's host list; without it each visible connection is tried. */
  remoteWorkspaceConnectionId?: string | null;
}

export const isRemoteWorkspaceHost = (host: WorkspaceHost): boolean =>
  isRemoteWorkspaceProvider(host.origin);

export function RemoteWorkspaceBadge({ host }: { host: WorkspaceHost }) {
  if (!isRemoteWorkspaceHost(host)) return null;
  const ws = host.remoteWorkspaceName;
  const label = providerLabel(host.origin);
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary whitespace-nowrap"
      title={`A ${label} workspace Optio started for work; it pairs itself`}
    >
      <Boxes className="w-2.5 h-2.5" />
      {label}
      {ws && ws !== host.name ? ` · ${ws}` : ""}
    </span>
  );
}

/**
 * Stop the workspace through the connection that started it. The host list
 * may not name the connection, so the visible ones of its provider are
 * tried in the order they apply until one reaches the workspace.
 */
export async function stopRemoteWorkspaceHost(host: WorkspaceHost): Promise<string> {
  const wsId = host.remoteWorkspaceId;
  if (!wsId) throw new Error("This workspace hasn't been created at its provider yet");
  const provider = isRemoteWorkspaceProvider(host.origin) ? host.origin : undefined;
  const ids = host.remoteWorkspaceConnectionId
    ? [host.remoteWorkspaceConnectionId]
    : sortConnections((await api.listRemoteWorkspaceConnections(provider)).connections).map(
        (c) => c.id,
      );
  let last: unknown = new Error("No connection reaches this workspace");
  for (const id of ids) {
    try {
      return (await api.stopRemoteWorkspace(id, wsId)).status;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export function StopRemoteWorkspace({ host }: { host: WorkspaceHost }) {
  const [busy, setBusy] = useState(false);
  if (!isRemoteWorkspaceHost(host) || !host.remoteWorkspaceId) return null;
  const name = host.remoteWorkspaceName || host.name;
  const label = providerLabel(host.origin);
  const pause =
    isRemoteWorkspaceProvider(host.origin) &&
    REMOTE_WORKSPACE_PROVIDER_INFO[host.origin].stopVerb === "pause";
  const stop = async () => {
    if (!confirm(`Stop the ${label} workspace “${name}”? Whatever runs in it stops with it.`)) {
      return;
    }
    setBusy(true);
    try {
      const status = await stopRemoteWorkspaceHost(host);
      toast.success(`Stopping ${name}`, { description: `${label}: ${status}` });
    } catch (err) {
      toast.error("Failed to stop the workspace", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
    setBusy(false);
  };
  return (
    <Button variant="ghost" size="sm" onClick={stop} disabled={busy}>
      <Square />
      {busy ? (pause ? "Pausing…" : "Stopping…") : pause ? "Pause workspace" : "Stop workspace"}
    </Button>
  );
}
