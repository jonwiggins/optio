"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type DeploymentSettings } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { forgetMergeConfirmation } from "@/hooks/use-merge-confirmation";

/**
 * Settings → Access → Automatic merging: whether turning automatic merging
 * on needs a confirmation, and Optio merges only what someone confirmed
 * (docs/merge-confirmation.md). Off by default. Saved here, it wins over the
 * deployment's own default (`OPTIO_MERGE_CONFIRMATION`, chart
 * `merge.confirmation`); "Follow the deployment" removes the saved value.
 * Shown to deployment admins only (services/deployment-admin-gates.ts).
 */

type Choice = "on" | "off" | "deployment";

const word = (on: boolean) => (on ? "On" : "Off");

export function MergeConfirmationSettings() {
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  const mc = settings?.mergeConfirmation;
  if (!settings?.canEdit || !mc) return null;
  const choice: Choice = mc.source === "app" ? (mc.value ? "on" : "off") : "deployment";

  const pick = async (next: Choice) => {
    if (saving || next === choice) return;
    setSaving(true);
    try {
      setSettings(
        await api.updateDeploymentSettings({
          mergeConfirmation: next === "deployment" ? null : next === "on",
        }),
      );
      forgetMergeConfirmation();
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
      label="Automatic merging"
      hint="Ask before Optio merges by itself"
      summary={word(mc.value)}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        On: turning automatic merging on for a repo or a piece of work needs the checkbox and a
        confirmation, and Optio merges only what someone confirmed (a setting that was on before
        waits for a confirmation). Before merging it reads the PR and every review again and never
        merges over a reviewer who requested changes. Off: the checkbox alone decides.
      </p>
      <div data-testid="merge-confirmation">
        <Segmented
          value={choice}
          onChange={(next) => void pick(next)}
          aria-label="Automatic merging needs a confirmation"
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
            {
              value: "deployment",
              label: `Follow the deployment (${word(mc.environment).toLowerCase()})`,
            },
          ]}
        />
      </div>
    </SectionCard>
  );
}
