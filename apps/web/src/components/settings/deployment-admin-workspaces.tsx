"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type DeploymentSettings, type DirectoryWorkspace } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { BTN_ROW, Tag } from "@/components/settings/settings-ui";

/**
 * Settings → Access → Deployment admins in every workspace. Off by default:
 * a deployment admin gets into a workspace as everyone does, by being added
 * or by email domain. On, every deployment admin sees every workspace here
 * and may join any as an admin — an ordinary admin membership that the
 * workspace's members list shows and its admins can remove; it stays when
 * the setting is turned off again. Saved here, it wins over the deployment's
 * own default (`OPTIO_DEPLOYMENT_ADMINS_JOIN_ANY_WORKSPACE`, chart
 * `deploymentAdmins.joinAnyWorkspace`). Shown to deployment admins only; the
 * API refuses anyone else.
 */

type Choice = "on" | "off" | "deployment";

const word = (on: boolean) => (on ? "On" : "Off");

const LIST_CLASS = "divide-y divide-border/60 rounded-lg border border-border bg-bg";

export function DeploymentAdminWorkspaces() {
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);
  const [directory, setDirectory] = useState<DirectoryWorkspace[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  const sw = settings?.deploymentAdminsJoinAnyWorkspace;
  const on = !!sw?.value;
  useEffect(() => {
    if (!settings?.canEdit || !on) {
      setDirectory(null);
      return;
    }
    api
      .listWorkspaceDirectory()
      .then((res) => setDirectory(res.workspaces))
      .catch(() => setDirectory([]));
  }, [settings?.canEdit, on]);

  if (!settings?.canEdit || !sw) return null;
  const choice: Choice = sw.source === "app" ? (sw.value ? "on" : "off") : "deployment";

  const pick = async (next: Choice) => {
    if (saving || next === choice) return;
    setSaving(true);
    try {
      setSettings(
        await api.updateDeploymentSettings({
          deploymentAdminsJoinAnyWorkspace: next === "deployment" ? null : next === "on",
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

  const join = async (ws: DirectoryWorkspace) => {
    setJoining(ws.id);
    try {
      await api.joinWorkspaceAsAdmin(ws.id);
      setDirectory(
        (rows) => rows?.map((r) => (r.id === ws.id ? { ...r, role: "admin" } : r)) ?? null,
      );
      toast.success(`You're an admin of ${ws.name}`, {
        description: "Switch to it from the workspace menu.",
      });
    } catch (err) {
      toast.error("Couldn't join", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setJoining(null);
    }
  };

  return (
    <SectionCard
      label="Deployment admins in every workspace"
      hint="See every workspace and join any as an admin"
      summary={word(sw.value)}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        On: every deployment admin sees all the workspaces below and can join any of them as an
        admin. Joining adds an ordinary admin membership that the workspace&apos;s members list
        shows and its admins can remove; it stays if this is turned off again. Off: a deployment
        admin gets into a workspace like everyone else, by being added.
      </p>
      <div data-testid="join-any-switch">
        <Segmented
          value={choice}
          onChange={(next) => void pick(next)}
          aria-label="Let deployment admins join any workspace"
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
      {on && directory && directory.length > 0 && (
        <ul className={LIST_CLASS} aria-label="Every workspace">
          {directory.map((ws) => (
            <li key={ws.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">{ws.name}</span>{" "}
                <span className="text-xs text-text-muted">
                  {ws.members} {ws.members === 1 ? "member" : "members"}
                </span>
              </div>
              {ws.role === "admin" ? (
                <Tag tone="success">admin</Tag>
              ) : (
                <>
                  {ws.role && <Tag>{ws.role}</Tag>}
                  <button
                    onClick={() => void join(ws)}
                    disabled={joining !== null}
                    className={BTN_ROW}
                    aria-label={`Join ${ws.name} as an admin`}
                  >
                    {ws.role ? "Become admin" : "Join as admin"}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
