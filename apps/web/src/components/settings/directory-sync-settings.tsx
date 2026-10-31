"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, Loader2, RefreshCw, UserX } from "lucide-react";
import {
  directorySyncApi,
  type DirectorySyncRun,
  type DirectorySyncView,
  type DisabledPerson,
} from "@/lib/directory-sync-api";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SectionCard } from "@/components/ui/section-card";
import { Disclosure } from "@/components/ui/disclosure";
import { ConfirmPopover } from "@/components/ui/confirm-popover";
import { formatRelativeTime } from "@/lib/utils";
import {
  BTN_PRIMARY,
  BTN_ROW,
  BTN_SECONDARY,
  BTN_TEXT,
  CardFooter,
  Field,
  INPUT,
  InsetForm,
  SkeletonCard,
  Tag,
} from "./settings-ui";

/**
 * Settings → Access → Directory sync (docs/directory-sync.md): Optio
 * re-reads every person who signs in with LDAP / Active Directory on a
 * schedule, applies their groups as a sign-in would, and disables the ones
 * who left — sessions and API keys revoked, their own schedules and
 * triggered automations paused. Here a deployment admin
 * turns it on, picks the interval, runs it now, sees the last run and who is
 * disabled (with the automations Optio paused for them), enables someone
 * again, or disables and signs out someone by hand. Shown to deployment
 * admins only; the API refuses everyone else.
 */

const PRESETS = [15, 30, 60, 120, 240, 720, 1440];

export function intervalLabel(minutes: number): string {
  if (minutes === 1440) return "1 day";
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

const OUTCOME_LABEL: Record<string, string> = {
  changed: "groups re-applied",
  disabled: "disabled",
  enabled: "enabled again",
  still_disabled: "still disabled",
  would_disable: "would be disabled",
  kept_last_admin: "kept: the last deployment admin",
  error: "couldn't be checked",
};

const KIND_LABEL: Record<string, string> = {
  "repo-blueprint": "scheduled Task",
  standalone: "Job",
  "local-blueprint": "Local automation",
  "persistent-agent": "persistent agent",
};

function runSummary(run: DirectorySyncRun): string {
  const parts = [`${run.checked} checked`, `${run.changed} changed`, `${run.disabled} disabled`];
  if (run.enabled) parts.push(`${run.enabled} enabled again`);
  if (run.errors) parts.push(`${run.errors} couldn't be checked`);
  return parts.join(" · ");
}

function StatusTag({ run }: { run: DirectorySyncRun }) {
  if (run.status === "ok") return <Tag tone="success">Done</Tag>;
  if (run.status === "held") return <Tag tone="warning">Held</Tag>;
  if (run.status === "failed") return <Tag tone="error">Changed nobody</Tag>;
  return <Tag tone="primary">Running</Tag>;
}

export function DirectorySyncSettings() {
  const { isDeploymentAdmin, loaded } = useCurrentUser();
  const [view, setView] = useState<DirectorySyncView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalMinutes] = useState(30);
  const [busy, setBusy] = useState<"save" | "run" | "force" | "disable" | string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [disableEmail, setDisableEmail] = useState("");
  const [askDisable, setAskDisable] = useState(false);

  const apply = useCallback((v: DirectorySyncView) => {
    setView(v);
    setEnabled(v.settings.enabled);
    setIntervalMinutes(v.settings.intervalMinutes);
  }, []);

  const load = useCallback(
    () =>
      directorySyncApi
        .get()
        .then(apply)
        .catch(() => toast.error("Couldn't load the directory sync")),
    [apply],
  );

  useEffect(() => {
    if (!loaded || !isDeploymentAdmin) return;
    void load();
  }, [loaded, isDeploymentAdmin, load]);

  if (!loaded || !isDeploymentAdmin) return null;
  const label = "Directory sync";
  const hint = "Disable people who left the directory";
  if (!view) return <SkeletonCard id="directory-sync" label={label} hint={hint} rows={3} />;

  const { settings } = view;
  const dirty = enabled !== settings.enabled || interval !== settings.intervalMinutes;
  const savedHere = settings.source.enabled === "app" || settings.source.intervalMinutes === "app";
  const options = PRESETS.includes(interval)
    ? PRESETS
    : [...PRESETS, interval].sort((a, b) => a - b);

  const save = async (body: { enabled?: boolean | null; intervalMinutes?: number | null }) => {
    setBusy("save");
    try {
      apply(await directorySyncApi.update(body));
      toast.success("Saved");
    } catch (err) {
      toast.error("Couldn't save", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const run = async (force = false) => {
    setBusy(force ? "force" : "run");
    try {
      const done = await directorySyncApi.run(force);
      if (done.status === "ok") toast.success(`Directory sync done: ${runSummary(done)}`);
      else toast.warning(done.error ?? "The directory sync changed nobody");
      await load();
      setShowDetails(done.status !== "ok" || done.details.length > 0);
    } catch (err) {
      toast.error("Couldn't run the directory sync", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    const email = disableEmail.trim();
    setAskDisable(false);
    if (!email) return;
    setBusy("disable");
    try {
      const r = await directorySyncApi.disable({ email });
      toast.success(`${r.displayName} is disabled and signed out everywhere`, {
        description: `${r.revokedSessions ?? 0} sessions and ${r.revokedApiKeys ?? 0} API keys revoked; ${r.paused ?? 0} automations paused.`,
      });
      setDisableEmail("");
      await load();
    } catch (err) {
      toast.error("Couldn't disable", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const enable = async (p: DisabledPerson) => {
    setBusy(`enable:${p.id}`);
    try {
      const r = await directorySyncApi.enable(p.id);
      toast.success(`${r.displayName} can sign in again`, {
        description: r.resumed ? `${r.resumed} paused automations are back on.` : undefined,
      });
      await load();
    } catch (err) {
      toast.error("Couldn't enable", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const last = view.lastRun;
  const summary = !view.ldapConfigured
    ? "Needs LDAP sign-in"
    : settings.enabled
      ? `Every ${intervalLabel(settings.intervalMinutes)}`
      : "Off";

  return (
    <SectionCard
      id="directory-sync"
      label={label}
      hint={hint}
      summary={summary}
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">
        Optio re-reads everyone who signs in with LDAP / Active Directory and applies their groups
        as a sign-in would (admin groups, workspaces). Someone whose entry is gone, who is disabled
        in Active Directory or who is no longer in a group allowed to sign in is disabled: their
        sessions and API keys stop working, their own schedules and triggered automations are
        paused. Work of theirs already running finishes. When they are back in the groups, the
        account and its automations come back on.
      </p>
      {view.note && (
        <p className="flex items-start gap-1.5 text-xs text-warning" data-testid="ldap-needed">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          {view.note}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field
          label="Schedule"
          help={
            settings.source.enabled === "app"
              ? "Saved here"
              : `From the deployment (${settings.environment.enabled ? "on" : "off"})`
          }
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!view.ldapConfigured || busy !== null}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Sync on a schedule
          </label>
        </Field>
        <Field
          label="Every"
          help={
            settings.source.intervalMinutes === "app"
              ? "Saved here"
              : `From the deployment (${intervalLabel(settings.environment.intervalMinutes)})`
          }
        >
          <select
            aria-label="Interval"
            value={interval}
            disabled={!view.ldapConfigured || busy !== null}
            onChange={(e) => setIntervalMinutes(Number(e.target.value))}
            className={INPUT}
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {intervalLabel(m)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="space-y-2 pt-3 border-t border-border/60" data-testid="last-run">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Last run</span>
          {last ? (
            <>
              <StatusTag run={last} />
              {last.forced && <Tag tone="warning">Forced</Tag>}
              <span className="text-xs text-text-muted">
                {formatRelativeTime(last.startedAt)} ·{" "}
                {last.trigger === "manual" ? "run by hand" : "scheduled"}
              </span>
            </>
          ) : (
            <span className="text-xs text-text-muted">never</span>
          )}
          {view.running && <Tag tone="primary">A run is in progress</Tag>}
        </div>
        {last && <p className="text-xs text-text-muted">{runSummary(last)}</p>}
        {last?.error && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            {last.error}
          </p>
        )}
        {last && last.details.length > 0 && (
          <Disclosure
            open={showDetails}
            onToggle={() => setShowDetails((o) => !o)}
            label={`Who (${last.details.length})`}
          >
            <ul className="space-y-1 text-xs">
              {last.details.map((d) => (
                <li key={`${d.userId}-${d.outcome}`} className="flex flex-wrap gap-x-2">
                  <span className="font-mono">{d.email}</span>
                  <span className="text-text-muted">
                    {OUTCOME_LABEL[d.outcome] ?? d.outcome}
                    {d.reason ? ` (${d.reason.replace(/_/g, " ")})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
        {last?.status === "held" && (
          <button
            type="button"
            onClick={() => void run(true)}
            disabled={busy !== null}
            className={BTN_SECONDARY}
          >
            {busy === "force" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Disable them anyway
          </button>
        )}
      </div>

      <div className="space-y-2 pt-3 border-t border-border/60" data-testid="disabled-people">
        <div className="text-sm font-medium">Disabled accounts</div>
        {view.disabledPeople.length === 0 ? (
          <p className="text-xs text-text-muted">Nobody is disabled.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {view.disabledPeople.map((p) => (
              <li key={p.id} className="p-3 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{p.displayName}</span>
                  <span className="text-xs text-text-muted font-mono">{p.email}</span>
                  <Tag tone={p.byHand ? "warning" : "muted"}>{p.reasonLabel}</Tag>
                  <span className="text-xs text-text-muted">
                    {formatRelativeTime(p.disabledAt)}
                    {p.disabledBy ? ` by ${p.disabledBy.displayName}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => void enable(p)}
                    disabled={busy !== null}
                    className={`${BTN_ROW} ml-auto`}
                    aria-label={`Enable ${p.displayName}`}
                  >
                    Enable
                  </button>
                </div>
                {p.paused.length > 0 && (
                  <div className="text-xs text-text-muted">
                    Paused:{" "}
                    {p.paused.map((a, i) => (
                      <span key={a.path}>
                        {i > 0 && ", "}
                        <Link href={a.path} className="text-primary hover:underline">
                          {a.name}
                        </Link>{" "}
                        ({KIND_LABEL[a.kind] ?? a.kind})
                      </span>
                    ))}
                  </div>
                )}
                {p.pausedHidden > 0 && (
                  <div className="text-xs text-text-muted">
                    {p.pausedHidden} more paused in workspaces you don&apos;t administer.
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-text-muted/80">
          Enabling lets the person sign in again and turns the automations Optio paused back on. If
          the directory still says they left, the next sync disables them again; an account disabled
          by hand stays disabled until someone enables it here.
        </p>
      </div>

      <InsetForm>
        <Field
          label="Disable and sign out everywhere"
          help="By email, for anyone who signed in once — whatever their sign-in. The directory sync never enables an account disabled this way."
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Email of the person to disable"
              value={disableEmail}
              onChange={(e) => setDisableEmail(e.target.value)}
              placeholder="someone@example.com"
              className={`${INPUT} flex-1 min-w-[12rem]`}
            />
            <ConfirmPopover
              open={askDisable}
              title={`Disable ${disableEmail.trim()}?`}
              detail="Their sessions and API keys are revoked and their own automations paused."
              confirmLabel="Disable"
              busy={busy === "disable"}
              onConfirm={() => void disable()}
              onCancel={() => setAskDisable(false)}
            >
              <button
                type="button"
                onClick={() => setAskDisable(true)}
                disabled={!disableEmail.trim() || busy !== null}
                className={BTN_SECONDARY}
              >
                <UserX className="w-3.5 h-3.5" />
                Disable
              </button>
            </ConfirmPopover>
          </div>
        </Field>
      </InsetForm>

      <CardFooter note={savedHere ? <Tag tone="primary">Saved here</Tag> : "From the deployment"}>
        {savedHere && (
          <button
            type="button"
            onClick={() => void save({ enabled: null, intervalMinutes: null })}
            disabled={busy !== null}
            className={BTN_TEXT}
          >
            Use the deployment&apos;s
          </button>
        )}
        <button
          type="button"
          onClick={() => void run()}
          disabled={!view.ldapConfigured || view.running || busy !== null}
          className={BTN_SECONDARY}
        >
          {busy === "run" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Run now
        </button>
        <button
          type="button"
          onClick={() => void save({ enabled, intervalMinutes: interval })}
          disabled={!dirty || busy !== null}
          className={BTN_PRIMARY}
        >
          {busy === "save" ? "Saving…" : "Save schedule"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}
