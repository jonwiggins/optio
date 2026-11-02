"use client";

import { Segmented } from "@/components/ui/segmented";
import { useCurrentUser } from "@/hooks/use-current-user";
import { WORKSPACE_ADMIN_ONLY } from "@/components/settings/settings-ui";

/**
 * Whose defaults a Settings → Agents card shows and saves: the current
 * workspace's, or the deployment's, which every workspace without its own
 * reads (a deployment admin's to set).
 */
export type DefaultsScope = "workspace" | "deployment";

/** Where a value a card shows comes from (the API's `source`). */
export type DefaultsSource = "workspace" | "deployment" | "builtin";

export const DEPLOYMENT_ADMIN_ONLY = "Only a deployment admin changes the deployment defaults";

/** Who may save a card in `scope`, and the note beside a disabled Save otherwise. */
export function useDefaultsEditing(scope: DefaultsScope): {
  canEdit: boolean;
  refusal: string;
} {
  const { isAdmin, isDeploymentAdmin } = useCurrentUser();
  return scope === "deployment"
    ? { canEdit: isDeploymentAdmin, refusal: DEPLOYMENT_ADMIN_ONLY }
    : { canEdit: isAdmin, refusal: WORKSPACE_ADMIN_ONLY };
}

/**
 * The "This workspace / Deployment defaults" switch above the Agents cards,
 * for a deployment admin when sign-in is on (with it off there is one scope).
 */
export function DefaultsScopeSwitch({
  scope,
  onChange,
}: {
  scope: DefaultsScope;
  onChange: (scope: DefaultsScope) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-card p-4 space-y-2">
      <Segmented
        aria-label="Defaults for"
        value={scope}
        onChange={onChange}
        options={[
          { value: "workspace", label: "This workspace" },
          { value: "deployment", label: "Deployment defaults" },
        ]}
      />
      <p className="text-xs text-text-muted">
        {scope === "deployment"
          ? "Deployment defaults apply to every workspace, new ones included, until that " +
            "workspace saves its own. Workspaces that already saved their own keep them."
          : "The settings below are this workspace's. A workspace that hasn't saved its own " +
            "uses the deployment defaults."}
      </p>
    </div>
  );
}

const SOURCE_TEXT: Record<DefaultsScope, Record<DefaultsSource, string>> = {
  workspace: {
    workspace: "Set for this workspace",
    deployment: "From the deployment defaults until this workspace saves its own",
    builtin: "Built-in default",
  },
  deployment: {
    workspace: "Deployment default",
    deployment: "Deployment default",
    builtin: "Built-in default: no deployment default saved yet",
  },
};

/** Where the values a card shows come from; nothing with sign-in off (one scope) or unknown. */
export function SourceNote({
  scope,
  source,
}: {
  scope: DefaultsScope;
  source: DefaultsSource | null | undefined;
}) {
  const { authDisabled } = useCurrentUser();
  if (authDisabled || !source) return null;
  return <span className="text-xs text-text-muted">{SOURCE_TEXT[scope][source]}</span>;
}
