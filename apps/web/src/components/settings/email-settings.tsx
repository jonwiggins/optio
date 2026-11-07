"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Send } from "lucide-react";
import {
  notifyApi,
  type SaveSmtpSettings,
  type SmtpSecurity,
  type SmtpSettingsView,
} from "@/lib/notify-api";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_TEXT,
  CardFooter,
  Field,
  INPUT,
  MONO_AREA,
  SkeletonCard,
  Tag,
} from "./settings-ui";

/**
 * Settings → Notifications → Email (docs/notifications.md): the SMTP relay
 * Optio's email goes out through — the whole deployment's, so only a
 * deployment admin sees this card. Saved here it wins over the deployment's
 * OPTIO_SMTP_URL; "Send test email" tries the form as it stands, saved or not.
 */

const SECURITY: Array<{ value: SmtpSecurity; label: string; port: number }> = [
  { value: "starttls", label: "STARTTLS when offered (may send unencrypted)", port: 587 },
  { value: "starttls-required", label: "STARTTLS, required", port: 587 },
  { value: "tls", label: "TLS from the start (smtps)", port: 465 },
  { value: "none", label: "None (no encryption)", port: 25 },
];

export interface Draft {
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  password: string;
  clearPassword: boolean;
  from: string;
  caPem: string;
  insecureSkipVerify: boolean;
  enabled: boolean;
}

function draftOf(s: SmtpSettingsView): Draft {
  return {
    host: s.host,
    port: s.port ? String(s.port) : "",
    security: s.security,
    username: s.username ?? "",
    password: "",
    clearPassword: false,
    from: s.from,
    caPem: s.caPem ?? "",
    insecureSkipVerify: s.insecureSkipVerify,
    enabled: s.source ? s.enabled : true,
  };
}

/** The form as the API takes it; a string to show when it can't be sent. */
export function bodyOf(d: Draft): SaveSmtpSettings | string {
  if (!d.host.trim()) return "Give the relay's host name";
  if (!d.from.trim()) return "Give the address Optio's email comes from";
  const port = d.port.trim() ? Number(d.port) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return "The port is a number from 1 to 65535";
  }
  return {
    host: d.host.trim(),
    port,
    security: d.security,
    username: d.username.trim() || null,
    password: d.clearPassword ? null : d.password,
    from: d.from.trim(),
    caPem: d.caPem.trim() || null,
    insecureSkipVerify: d.insecureSkipVerify,
    enabled: d.enabled,
  };
}

export function EmailSettings() {
  const { isDeploymentAdmin, user, loaded } = useCurrentUser();
  const [view, setView] = useState<SmtpSettingsView | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!loaded || !isDeploymentAdmin) return;
    notifyApi
      .getSmtpSettings()
      .then(({ settings }) => {
        setView(settings);
        setDraftState(draftOf(settings));
      })
      .catch(() => toast.error("Couldn't load the email settings"));
  }, [loaded, isDeploymentAdmin]);

  if (!loaded || !isDeploymentAdmin) return null;
  const label = "Email";
  const hint = "The SMTP relay Optio sends through";
  if (!view || !draft) return <SkeletonCard id="email" label={label} hint={hint} rows={4} />;

  const setDraft = (patch: Partial<Draft>) => setDraftState({ ...draft, ...patch });
  const defaultPort = SECURITY.find((s) => s.value === draft.security)?.port ?? 587;

  const save = async () => {
    const body = bodyOf(draft);
    if (typeof body === "string") return toast.error(body);
    setBusy("save");
    try {
      const { settings } = await notifyApi.saveSmtpSettings(body);
      setView(settings);
      setDraftState(draftOf(settings));
      toast.success("Email settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the email settings");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    const body = bodyOf(draft);
    if (typeof body === "string") return toast.error(body);
    setBusy("test");
    setTestResult(null);
    try {
      const r = await notifyApi.sendTestEmail({ to: testTo.trim() || undefined, settings: body });
      setTestResult(
        r.ok
          ? { ok: true, text: `Sent to ${r.to}. ${r.response}` }
          : { ok: false, text: `Not sent to ${r.to}: ${r.error}` },
      );
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      const { settings } = await notifyApi.deleteSmtpSettings();
      setView(settings);
      setDraftState(draftOf(settings));
      toast.success(
        settings.source === "env"
          ? "Removed; the deployment's relay applies again"
          : "Removed; Optio sends no email",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the email settings");
    } finally {
      setBusy(null);
    }
  };

  const status =
    view.source === "app"
      ? view.enabled
        ? "Saved here"
        : "Turned off"
      : view.source === "env"
        ? "From the deployment"
        : "Not set up";

  return (
    <SectionCard
      id="email"
      label={label}
      hint={hint}
      summary={status}
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">
        Optio emails people about their work (a merge request waiting for them, work that needs them
        or failed) through your organization&apos;s relay. Settings saved here win over the
        deployment&apos;s <code>OPTIO_SMTP_URL</code>.
        {view.source === "env" && " The values below come from the deployment."}
      </p>
      {view.envError && (
        <p className="flex items-start gap-1.5 text-xs text-warning" data-testid="env-error">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          The deployment&apos;s relay can&apos;t be used: {view.envError}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_7rem] gap-3">
        <Field label="Host" help="The relay's name or address, without smtp://">
          <input
            aria-label="SMTP host"
            value={draft.host}
            onChange={(e) => setDraft({ host: e.target.value })}
            placeholder="smtp.example.com"
            className={INPUT}
          />
        </Field>
        <Field label="Port">
          <input
            aria-label="SMTP port"
            inputMode="numeric"
            value={draft.port}
            onChange={(e) => setDraft({ port: e.target.value })}
            placeholder={String(defaultPort)}
            className={INPUT}
          />
        </Field>
      </div>
      <Field label="Encryption">
        <select
          aria-label="Encryption"
          value={draft.security}
          onChange={(e) => setDraft({ security: e.target.value as SmtpSecurity })}
          className={INPUT}
        >
          {SECURITY.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="User name" help="Leave empty for a relay that takes mail without signing in">
          <input
            aria-label="SMTP user name"
            value={draft.username}
            autoComplete="off"
            onChange={(e) => setDraft({ username: e.target.value })}
            className={INPUT}
          />
        </Field>
        <Field
          label="Password"
          help={
            view.hasPassword
              ? "Stored. Leave empty to keep it (same host and user name only)."
              : "Optio seals it and never shows it again."
          }
        >
          <input
            aria-label="SMTP password"
            type="password"
            autoComplete="new-password"
            value={draft.password}
            disabled={draft.clearPassword}
            onChange={(e) => setDraft({ password: e.target.value })}
            placeholder={view.hasPassword ? "••••••" : ""}
            className={INPUT}
          />
          {view.hasPassword && view.source === "app" && (
            <label className="flex items-center gap-2 text-xs mt-1.5">
              <input
                type="checkbox"
                checked={draft.clearPassword}
                onChange={(e) => setDraft({ clearPassword: e.target.checked, password: "" })}
              />
              Remove the stored password
            </label>
          )}
        </Field>
      </div>
      <Field label="From" help="The sender people see, like Optio <optio@example.com>">
        <input
          aria-label="From address"
          value={draft.from}
          onChange={(e) => setDraft({ from: e.target.value })}
          placeholder="Optio <optio@example.com>"
          className={INPUT}
        />
      </Field>
      <Field
        label="CA certificate"
        help="Only when the relay's certificate is from a CA the deployment's CA bundle doesn't hold."
      >
        <textarea
          aria-label="SMTP CA certificate"
          rows={3}
          value={draft.caPem}
          onChange={(e) => setDraft({ caPem: e.target.value })}
          placeholder="-----BEGIN CERTIFICATE-----"
          className={MONO_AREA}
        />
      </Field>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.insecureSkipVerify}
            onChange={(e) => setDraft({ insecureSkipVerify: e.target.checked })}
          />
          Skip TLS verification
        </label>
        {draft.insecureSkipVerify && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            Anyone between Optio and the relay could read the password. For testing only: give the
            CA above instead.
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ enabled: e.target.checked })}
          />
          Send email
        </label>
      </div>

      <div className="space-y-2 pt-3 border-t border-border/60">
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Send the test email to"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder={user?.email ?? "you@example.com"}
            className={`${INPUT} flex-1 min-w-[12rem]`}
          />
          <button type="button" onClick={test} disabled={busy !== null} className={BTN_SECONDARY}>
            <Send className="w-3.5 h-3.5" />
            {busy === "test" ? "Sending…" : "Send test email"}
          </button>
        </div>
        {testResult && (
          <p
            role="status"
            className={`text-xs ${testResult.ok ? "text-success" : "text-error"} break-words`}
          >
            {testResult.text}
          </p>
        )}
      </div>

      <CardFooter
        note={
          view.source === "app" ? (
            <Tag tone={view.enabled ? "success" : "muted"}>{status}</Tag>
          ) : (
            status
          )
        }
      >
        {view.source === "app" && (
          <button type="button" onClick={remove} disabled={busy !== null} className={BTN_TEXT}>
            {view.envConfigured ? "Use the deployment's" : "Remove"}
          </button>
        )}
        <button type="button" onClick={save} disabled={busy !== null} className={BTN_PRIMARY}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}
