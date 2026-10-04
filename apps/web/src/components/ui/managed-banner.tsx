"use client";

import { useState } from "react";
import { Download, FileCode2, Unlink } from "lucide-react";
import { toast } from "sonner";
import type { ManagedBy } from "@optio/shared";
import { api } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { cn } from "@/lib/utils";

/**
 * The notice on the pages of a resource a configuration directory manages
 * (config as code): the file is the truth, so an edit made here is put back at
 * the next sync. Offers the YAML as the API would export it today, and — for
 * admins — **Detach**, which makes the resource ordinary again.
 */
export function ManagedBanner({
  managedBy,
  resourceId,
  onDetached,
  className,
}: {
  managedBy?: ManagedBy | null;
  /** The resource's id (what `GET /api/config/export?id=` takes). */
  resourceId: string;
  /** Called after a detach succeeded (the page should reload its row). */
  onDetached?: () => void;
  className?: string;
}) {
  const { isAdmin } = useCurrentUser();
  const [busy, setBusy] = useState(false);
  if (!managedBy) return null;

  const detach = async () => {
    if (
      !confirm(
        `Stop managing this from ${managedBy.path}? It stays as it is and is edited by hand from now on. If the file stays in the directory, the next sync takes it over again.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.detachConfigObject(managedBy.objectId);
      toast.success("Detached — this is now edited by hand");
      onDetached?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't detach");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="note"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-bg-hover/60 px-3 py-2 text-xs text-text-muted",
        className,
      )}
    >
      <FileCode2 className="w-3.5 h-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-text-heading">Managed by {managedBy.sourceName}</span>
        {" · "}
        <code className="text-primary">{managedBy.path}</code>
        {" — edits made here are put back at the next sync; change the file instead."}
      </span>
      <a
        href={api.configExportUrl(managedBy.kind, resourceId)}
        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-bg-hover text-text-heading"
      >
        <Download className="w-3 h-3" />
        YAML
      </a>
      {isAdmin && (
        <button
          type="button"
          onClick={detach}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-bg-hover text-text-heading disabled:opacity-50"
        >
          <Unlink className="w-3 h-3" />
          Detach
        </button>
      )}
    </div>
  );
}

/** A "Download YAML" action for the page of any exportable resource. */
export function DownloadYamlLink({
  kind,
  resourceId,
  className,
}: {
  kind: string;
  resourceId: string;
  className?: string;
}) {
  return (
    <a
      href={api.configExportUrl(kind, resourceId)}
      title="Download this as a manifest (config as code)"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-heading hover:bg-bg-hover",
        className,
      )}
    >
      <Download className="w-3.5 h-3.5" />
      YAML
    </a>
  );
}
