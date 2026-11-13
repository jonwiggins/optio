"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type DeploymentAdmin, type DeploymentSettings } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { Tag } from "@/components/settings/settings-ui";

/**
 * Settings → Access → Admins of every workspace: the deployment admins — the
 * group managed under Sign-in → Deployment admins, and Helm's
 * `auth.deploymentAdmins` — become admins of every workspace, member or not
 * (`deployment-admins.all-workspaces`, docs/sign-in.md). Off by default.
 * Saved here, it wins over the deployment's own default
 * (`OPTIO_DEPLOYMENT_ADMINS_ALL_WORKSPACES`, chart
 * `auth.deploymentAdminsAllWorkspaces`); "Follow the deployment" removes the
 * saved value. Each change is logged. While it is on, every workspace's
 * members list shows them and its activity log records the days they act
 * there. Shown to deployment admins only; the API refuses anyone else.
 */

type Choice = "on" | "off" | "deployment";

const word = (on: boolean) => (on ? "On" : "Off");

export function DeploymentAdminsAllWorkspaces() {
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);
  const [admins, setAdmins] = useState<DeploymentAdmin[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!settings?.canEdit) return;
    api
      .listDeploymentAdmins()
      .then((res) => setAdmins(res.admins))
      .catch(() => setAdmins([]));
  }, [settings?.canEdit]);

  const sw = settings?.deploymentAdminsAllWorkspaces;
  if (!settings?.canEdit || !sw) return null;
  const choice: Choice = sw.source === "app" ? (sw.value ? "on" : "off") : "deployment";

  const pick = async (next: Choice) => {
    if (saving || next === choice) return;
    setSaving(true);
    try {
      setSettings(
        await api.updateDeploymentSettings({
          deploymentAdminsAllWorkspaces: next === "deployment" ? null : next === "on",
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
      label="Admins of every workspace"
      hint="The deployment admins administer all workspaces"
      summary={word(sw.value)}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        On: every deployment admin is an admin of every workspace, including ones they aren&apos;t a
        member of. Each workspace&apos;s members list shows them, and its activity log records the
        days they act there. Taking someone out of the deployment admins, or turning this off, ends
        their access. Off: a deployment admin works only in the workspaces they belong to.
      </p>
      <div data-testid="all-workspaces-switch">
        <Segmented
          value={choice}
          onChange={(next) => void pick(next)}
          aria-label="Make deployment admins admins of every workspace"
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
            {
              value: "deployment",
              label: `Follow the deployment (${word(sw.environment).toLowerCase()})`,
            },
          ]}
        />
      </div>
      {admins && admins.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-text-muted">
            The deployment admins ({admins.length}) — add or remove them under Sign-in → Deployment
            admins:
          </p>
          <ul className="flex flex-wrap gap-1.5" aria-label="Deployment admins">
            {admins.map((a) => (
              <li key={a.id}>
                <Tag tone={sw.value ? "primary" : "muted"} title={a.email}>
                  {a.displayName || a.email}
                </Tag>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
