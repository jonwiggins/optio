"use client";

import { Users } from "lucide-react";
import type { WorkspaceDeploymentAdminRow } from "@/lib/api-client";
import { Tag } from "@/components/settings/settings-ui";

/**
 * The members list's deployment admins: everyone who is an admin of this
 * workspace through the grant (Settings → Access → Admins of every
 * workspace), member or not, so the workspace's people see who can act in it.
 * Read-only here: who is a deployment admin is managed in Settings → Access.
 * Renders nothing while the grant is off (the API sends none).
 */
export function WorkspaceDeploymentAdmins({ admins }: { admins: WorkspaceDeploymentAdminRow[] }) {
  if (admins.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="workspace-deployment-admins">
      <p className="text-xs font-medium text-text-muted">
        Deployment admins — admins of every workspace (Settings → Access)
      </p>
      <ul
        className="divide-y divide-border/60 rounded-lg border border-border bg-bg"
        aria-label="Deployment admins in this workspace"
      >
        {admins.map((a) => (
          <li key={a.userId} className="flex items-center gap-3 px-3 py-2.5">
            {a.avatarUrl ? (
              <img src={a.avatarUrl} alt="" className="w-8 h-8 rounded-full shrink-0" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4 text-primary" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{a.displayName}</p>
              <p className="text-[11px] text-text-muted truncate">{a.email}</p>
            </div>
            <div className="flex items-center gap-1.5">
              {a.membershipRole && a.membershipRole !== "admin" && (
                <Tag title="Their own membership role here">also a {a.membershipRole}</Tag>
              )}
              {!a.membershipRole && <Tag title="Not in the members list above">not a member</Tag>}
              <Tag tone="primary">Deployment admin</Tag>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
