"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type DeploymentSettings, type DeploymentSwitch } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { useDeploymentSwitchesStore } from "@/hooks/use-deployment-switches";

/**
 * Settings → Access: the behaviours a deployment admin turns on for
 * everyone — Teams, a confirmation before automatic merging, and the
 * getting-started guide. All are off by default. Saved here, a choice wins
 * over the deployment's own default (`OPTIO_TEAMS_ENABLED` / chart
 * `teams.enabled`, `OPTIO_MERGE_CONFIRMATION` / chart `merge.confirmation`,
 * `OPTIO_ONBOARDING` / chart `onboarding.enabled`); "Follow the deployment"
 * removes the saved value. Shown to deployment admins only.
 */

type Key = "teams" | "mergeConfirmation" | "onboarding";
type Choice = "on" | "off" | "deployment";

const COPY: Record<Key, { label: string; hint: string; body: string; aria: string }> = {
  teams: {
    label: "Teams",
    hint: "Groups that own work, secrets and prompts together",
    body:
      "On: people create teams and ask to join them; work, secrets, prompts and ticket " +
      "providers can belong to a team, and the Teams page and the Team choice in pickers " +
      "appear. Off: everything belongs to the organization or to one person. Turning teams " +
      "off keeps the teams and what they own; their members just stop seeing it as a team's.",
    aria: "Teams",
  },
  mergeConfirmation: {
    label: "Automatic merging",
    hint: "Ask before Optio merges by itself",
    body:
      "On: turning automatic merging on for a repo or a piece of work needs the checkbox and " +
      "a confirmation, and Optio merges only what someone confirmed (a setting that was on " +
      "before waits for a confirmation). Off: the checkbox alone decides.",
    aria: "Automatic merging needs a confirmation",
  },
  onboarding: {
    label: "Getting-started guide",
    hint: "Show the getting-started guide",
    body:
      "On: the Overview shows each person a getting-started checklist (signing in, a " +
      "repository, a first task and its review, notifications) until they finish or hide it, " +
      "and the account menu gets Help → Using Optio. Off: neither shows.",
    aria: "Show the getting-started guide",
  },
};

const word = (on: boolean) => (on ? "On" : "Off");

function SwitchCard({
  which,
  value,
  saving,
  onPick,
}: {
  which: Key;
  value: DeploymentSwitch;
  saving: boolean;
  onPick: (next: Choice) => void;
}) {
  const copy = COPY[which];
  const choice: Choice = value.source === "app" ? (value.value ? "on" : "off") : "deployment";
  return (
    <SectionCard
      label={copy.label}
      hint={copy.hint}
      summary={word(value.value)}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">{copy.body}</p>
      <div data-testid={`deployment-switch-${which}`}>
        <Segmented
          value={choice}
          onChange={(next) => {
            if (!saving && next !== choice) onPick(next);
          }}
          aria-label={copy.aria}
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

export function DeploymentSwitchesSettings() {
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  if (!settings?.canEdit || !settings.teams || !settings.mergeConfirmation) return null;

  const pick = async (which: Key, next: Choice) => {
    setSaving(true);
    try {
      setSettings(
        await api.updateDeploymentSettings({
          [which]: next === "deployment" ? null : next === "on",
        }),
      );
      // The nav, the pickers, the merge checkbox and the guide follow at once.
      void useDeploymentSwitchesStore.getState().reload();
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
    <>
      <SwitchCard
        which="teams"
        value={settings.teams}
        saving={saving}
        onPick={(next) => void pick("teams", next)}
      />
      <SwitchCard
        which="mergeConfirmation"
        value={settings.mergeConfirmation}
        saving={saving}
        onPick={(next) => void pick("mergeConfirmation", next)}
      />
      {settings.onboarding && (
        <SwitchCard
          which="onboarding"
          value={settings.onboarding}
          saving={saving}
          onPick={(next) => void pick("onboarding", next)}
        />
      )}
    </>
  );
}
