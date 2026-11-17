"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Search, Trash2 } from "lucide-react";
import {
  api,
  type AccountCredentials,
  type DeploymentLimit,
  type DeploymentSettings,
} from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Button } from "@/components/ui/button";
import { INPUT } from "./settings-ui";

/**
 * Settings → Access → Sessions and API keys (deployment admins only):
 *
 * - the optional session max lifetime, idle timeout and CLI key lifetime.
 *   Each follows the deployment (`OPTIO_SESSION_MAX_HOURS`,
 *   `OPTIO_SESSION_IDLE_MINUTES`, `OPTIO_CLI_KEY_MAX_DAYS`, chart `auth.*`)
 *   until saved here; 0 saved is "no limit". None set: 30-day sessions, 7 days
 *   idle, CLI keys that never expire.
 * - a person's sessions and API keys, found by email, each revocable without
 *   disabling the account (routes/user-credentials.ts).
 */

type LimitField = "sessionMaxHours" | "sessionIdleMinutes" | "cliKeyMaxDays";

const LIMITS: Array<{ field: LimitField; label: string; unit: string; help: string }> = [
  {
    field: "sessionMaxHours",
    label: "Session lifetime",
    unit: "hours",
    help: "A browser session ends this long after sign-in, however active. None: 30 days.",
  },
  {
    field: "sessionIdleMinutes",
    label: "Idle timeout",
    unit: "minutes",
    help: "A browser session unused this long ends. None: 7 days.",
  },
  {
    field: "cliKeyMaxDays",
    label: "CLI key lifetime",
    unit: "days",
    help: "A key made by optio login expires after this. Applies to new keys; none: never.",
  },
];

const amount = (value: number | null, unit: string) =>
  value === null ? "none" : `${value} ${value === 1 ? unit.replace(/s$/, "") : unit}`;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "not yet");

export function CredentialLifetimeSettings() {
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  if (!settings?.canEdit || !settings.sessionMaxHours) return null;
  const active = LIMITS.filter((l) => settings[l.field]?.value != null).length;

  return (
    <SectionCard
      label="Sessions and API keys"
      hint="Lifetimes, and one person's sessions and keys"
      summary={active ? `${active} limit${active === 1 ? "" : "s"}` : "No limits"}
      bodyClassName="p-4 space-y-5"
    >
      <div className="space-y-3">
        {LIMITS.map((l) => (
          <LimitRow
            key={l.field}
            {...l}
            limit={settings[l.field]!}
            onSaved={(next) => setSettings(next)}
          />
        ))}
      </div>
      <UserCredentials />
    </SectionCard>
  );
}

function LimitRow({
  field,
  label,
  unit,
  help,
  limit,
  onSaved,
}: {
  field: LimitField;
  label: string;
  unit: string;
  help: string;
  limit: DeploymentLimit;
  onSaved: (s: DeploymentSettings) => void;
}) {
  const [draft, setDraft] = useState(
    limit.source === "app" ? String(limit.value ?? 0) : String(limit.value ?? ""),
  );
  const [saving, setSaving] = useState(false);

  const save = async (value: number | null) => {
    setSaving(true);
    try {
      const next = await api.updateDeploymentSettings({ [field]: value });
      onSaved(next);
      const now = next[field];
      setDraft(now?.source === "app" ? String(now.value ?? 0) : String(now?.value ?? ""));
      toast.success("Saved");
    } catch (err) {
      toast.error("Couldn't save", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const parsed = draft.trim() === "" ? null : Number(draft);
  const valid =
    parsed !== null &&
    Number.isInteger(parsed) &&
    (parsed === 0 || (parsed >= limit.min && parsed <= limit.max));

  return (
    <form
      className="space-y-1"
      data-testid={`limit-${field}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void save(parsed);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`limit-${field}`} className="text-sm font-medium w-36">
          {label}
        </label>
        <input
          id={`limit-${field}`}
          type="number"
          inputMode="numeric"
          min={0}
          max={limit.max}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="none"
          className={`${INPUT} w-28`}
        />
        <span className="text-xs text-text-muted">{unit}</span>
        <Button type="submit" size="sm" disabled={saving || !valid}>
          Save
        </Button>
        {limit.source === "app" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => void save(null)}
          >
            Follow the deployment ({amount(limit.environment, unit)})
          </Button>
        )}
      </div>
      <p className="text-xs text-text-muted">
        {help} Now: {amount(limit.value, unit)} (
        {limit.source === "app" ? "saved here" : "the deployment's default"}). 0 = no limit;{" "}
        {limit.min}-{limit.max}.
      </p>
    </form>
  );
}

function UserCredentials() {
  const [email, setEmail] = useState("");
  const [accounts, setAccounts] = useState<AccountCredentials[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const find = async (address = email) => {
    if (!address.trim()) return;
    setBusy("find");
    try {
      setAccounts((await api.findUserCredentials(address.trim())).accounts);
    } catch (err) {
      toast.error("Couldn't look them up", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: string, question: string, run: () => Promise<unknown>, done: string) => {
    if (!confirm(question)) return;
    setBusy(id);
    try {
      await run();
      toast.success(done);
      await find();
    } catch (err) {
      toast.error("Couldn't revoke", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 border-t border-border/60 pt-4">
      <p className="text-xs text-text-muted">
        Find a person by email to see their sign-in sessions and API keys, and end one without
        disabling the account. Each revocation is recorded in the action log.
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="person@example.com"
          aria-label="Email"
          className={`${INPUT} flex-1 min-w-[12rem] w-auto`}
        />
        <Button type="submit" size="sm" disabled={busy === "find" || !email.trim()}>
          {busy === "find" ? <Loader2 className="animate-spin" /> : <Search />}
          Find
        </Button>
      </form>
      {accounts?.length === 0 && (
        <p className="text-xs text-text-muted">No account has that email.</p>
      )}
      {accounts?.map(({ user, sessions, apiKeys }) => (
        <div
          key={user.id}
          className="rounded-lg border border-border bg-bg p-3 space-y-3"
          data-testid="user-credentials"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {user.displayName}{" "}
              <span className="text-xs text-text-muted">
                {user.email} · {user.provider} · last sign-in {when(user.lastLoginAt)}
              </span>
            </p>
            {sessions.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                className="hover:text-error hover:bg-error/10"
                onClick={() =>
                  void act(
                    `all-${user.id}`,
                    `End all of ${user.displayName}'s sessions? Their API keys keep working.`,
                    () => api.revokeAllUserSessions(user.id),
                    "Sessions ended",
                  )
                }
              >
                End all sessions
              </Button>
            )}
          </div>
          <ul className="divide-y divide-border/60 text-xs">
            {sessions.length === 0 && <li className="py-1.5 text-text-muted">No sessions.</li>}
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-text-muted">
                  Session · signed in {when(s.createdAt)} · last used {when(s.lastSeenAt)} · expires{" "}
                  {when(s.expiresAt)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`End session from ${when(s.createdAt)}`}
                  className="shrink-0 hover:text-error hover:bg-error/10"
                  onClick={() =>
                    void act(
                      s.id,
                      "End this session? That browser is signed out.",
                      () => api.revokeUserSession(user.id, s.id),
                      "Session ended",
                    )
                  }
                >
                  {busy === s.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  End
                </Button>
              </li>
            ))}
            {apiKeys.length === 0 && <li className="py-1.5 text-text-muted">No API keys.</li>}
            {apiKeys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-text-muted">
                  <span className="font-medium text-text-heading">{k.name}</span>{" "}
                  <span className="font-mono">{k.prefix}…</span> · created {when(k.createdAt)} ·
                  last used {when(k.lastUsedAt)} ·{" "}
                  {k.expiresAt ? `expires ${when(k.expiresAt)}` : "never expires"}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`Revoke ${k.name}`}
                  className="shrink-0 hover:text-error hover:bg-error/10"
                  onClick={() =>
                    void act(
                      k.id,
                      `Revoke "${k.name}"? Anything using it stops working immediately.`,
                      () => api.revokeUserApiKey(user.id, k.id),
                      "Key revoked",
                    )
                  }
                >
                  {busy === k.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
