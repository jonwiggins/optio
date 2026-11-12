"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Globe2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A deployment row's tag (docs/scope.md, "The deployment's own"): a row with
 * no workspace — the deployment's secret, connection, MCP server or skill.
 * The founding workspace uses every one; any other workspace only those a
 * deployment admin shares with every workspace. Everyone sees whether it is
 * shared; a deployment admin can change that from the tag.
 */
export function DeploymentShareTag({
  row,
  canShare,
  onShare,
}: {
  row: { workspaceId?: string | null; deploymentDefault?: boolean | null; deployment?: boolean };
  /** The viewer is a deployment admin. */
  canShare: boolean;
  /** Persist the new state; the caller refreshes its rows. */
  onShare: (shared: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const isDeploymentRow = row.deployment ?? !row.workspaceId;
  if (!isDeploymentRow) return null;
  const shared = !!row.deploymentDefault;
  const label = shared ? "Deployment · every workspace" : "Deployment · founding workspace";
  const title = shared
    ? "The deployment's, shared with every workspace. A workspace's own of the same name comes first."
    : "The deployment's. Only the founding workspace uses it; other workspaces don't see it.";
  const className = cn(
    "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0",
    shared ? "bg-primary/10 text-primary" : "bg-bg-hover text-text-muted",
  );

  if (!canShare)
    return (
      <span className={className} title={title}>
        <Globe2 className="w-3 h-3" />
        {label}
      </span>
    );

  return (
    <button
      type="button"
      className={cn(className, "hover:ring-1 hover:ring-primary/40 disabled:opacity-60")}
      title={`${title} Click to ${shared ? "stop sharing it" : "share it with every workspace"}.`}
      aria-label={shared ? "Stop sharing with every workspace" : "Share with every workspace"}
      aria-pressed={shared}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onShare(!shared);
          toast.success(shared ? "No longer shared" : "Shared with every workspace");
        } catch (err) {
          toast.error("Couldn't change sharing", {
            description: err instanceof Error ? err.message : undefined,
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Globe2 className="w-3 h-3" />}
      {label}
    </button>
  );
}
