"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type DeploymentSettings } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { reloadDeploymentSwitches } from "@/hooks/use-deployment-switches";

/**
 * Settings → Access → Teams (docs/teams.md): off by default. Saved here, the
 * choice wins over the deployment's own default (`OPTIO_TEAMS_ENABLED`);
 * "Follow the deployment" removes the saved value. Deployment admins only.
 */

type Choice = "on" | "off" | "deployment";

const word = (on: boolean) => (on ? "On" : "Off");

export function TeamsSwitchSettings() {
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  if (!settings?.canEdit || !settings.teams) return null;
  const value = settings.teams;
  const choice: Choice = value.source === "app" ? (value.value ? "on" : "off") : "deployment";

  const pick = async (next: Choice) => {
    setSaving(true);
    try {
      setSettings(
        await api.updateDeploymentSettings({ teams: next === "deployment" ? null : next === "on" }),
      );
      // The nav and the Team choice follow at once.
      void reloadDeploymentSwitches();
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
      label="Teams"
      hint="Groups of people that own work and secrets together"
      summary={word(value.value)}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        On: people create teams and ask to join them; work and secrets can belong to a team, and the
        Teams page and the Team choice in the work form appear. Off: everything belongs to the
        organization or to one person. Turning teams off keeps the teams and what they own; a
        team&apos;s work then reads as its creator&apos;s until teams are on again.
      </p>
      <div data-testid="deployment-switch-teams">
        <Segmented
          value={choice}
          onChange={(next) => {
            if (!saving && next !== choice) void pick(next);
          }}
          aria-label="Teams"
          options={[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
            {
              value: "deployment",
              label: `Follow the deployment (${word(value.environment).toLowerCase()})`,
            },
          ]}
        />
      </div>
    </SectionCard>
  );
}
