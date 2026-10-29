"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type DeploymentSettings } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";

/**
 * Settings → Access → Workspaces: who may create a workspace. By default
 * (`everyone`) anyone signed in makes one and is its admin; `admins` leaves
 * new workspaces, and the organization-wide secrets, to deployment admins.
 * Saved here, it wins over the deployment's
 * own default (`OPTIO_WORKSPACE_CREATION`, chart `workspaces.creation`);
 * "Follow the deployment" removes the saved value. Shown to deployment
 * admins only (services/deployment-admin-gates.ts).
 */

type Choice = "admins" | "everyone" | "deployment";

const LABEL: Record<"admins" | "everyone", string> = {
  admins: "Deployment admins only",
  everyone: "Everyone",
};

export function WorkspaceCreationSettings() {
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  if (!settings?.canEdit) return null;
  const { workspaceCreation: wc } = settings;
  const choice: Choice = wc.source === "app" ? wc.value : "deployment";

  const pick = async (next: Choice) => {
    if (saving || next === choice) return;
    setSaving(true);
    try {
      setSettings(
        await api.updateDeploymentSettings({
          workspaceCreation: next === "deployment" ? null : next,
        }),
      );
      toast.success("Saved");
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      label="Workspaces"
      hint="Who may create one"
      summary={LABEL[wc.value]}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        Whoever creates a workspace becomes its admin. With &quot;Deployment admins only&quot;, only
        deployment admins can create new workspaces. Existing workspace membership is unchanged.
      </p>
      <div data-testid="workspace-creation">
        <Segmented
          value={choice}
          onChange={(next) => void pick(next)}
          aria-label="Who may create a workspace"
          options={[
            { value: "everyone", label: LABEL.everyone },
            { value: "admins", label: LABEL.admins },
            {
              value: "deployment",
              label: `Follow the deployment (${LABEL[wc.environment].toLowerCase()})`,
            },
          ]}
        />
      </div>
    </SectionCard>
  );
}
