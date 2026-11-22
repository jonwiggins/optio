"use client";
import { useState } from "react";
import { toast } from "sonner";
import type { AnySignInSettings, SignInProviderTestResult } from "@optio/shared";
import { api } from "@/lib/api-client";
import { signInPath } from "@/lib/sign-in-path";
import { INPUT, MONO_AREA, HELP, BTN_PRIMARY } from "./settings-ui";
import {
  SIGN_IN_PROVIDER_LABEL,
  accessDraftOf,
  accessSettingsOf,
  parseDomains,
  orNull,
  errorMessage,
  Labeled,
  AccessSection,
  TestResultView,
  RemoveButton,
  CopyField,
  type ProviderFormProps,
} from "./oidc-sign-in-form";
export function AdditionalOAuthForm({
  view,
  config,
  setupToken,
  mode,
  onSaved,
  onRemoved,
}: ProviderFormProps) {
  const [clientId, setClientId] = useState(view.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [displayName, setDisplayName] = useState(view.displayName);
  const [settings, setSettings] = useState<Record<string, unknown>>({ ...(view.settings ?? {}) });
  const [access, setAccess] = useState(() => accessDraftOf(view));
  const [organizationName, setOrganizationName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SignInProviderTestResult | null>(null);
  const fields: Array<[string, string, boolean?]> =
    view.provider === "gitea"
      ? [
          ["baseUrl", "Gitea / Forgejo server URL"],
          ["scopes", "Scopes (default: openid profile email groups)"],
          ["caPem", "Server CA certificate (optional)", true],
        ]
      : [];
  const input = () => ({
    clientId: clientId.trim(),
    ...(secret ? { clientSecret: secret } : {}),
    displayName: displayName.trim(),
    settings: { ...settings, ...accessSettingsOf(access) } as AnySignInSettings,
    allowedDomains: parseDomains(access.allowedDomains),
    enabled: config.bootstrap || access.enabled,
    ...(config.bootstrap && organizationName.trim()
      ? { organizationName: organizationName.trim() }
      : {}),
  });
  const perform = async (test: boolean) => {
    setBusy(true);
    try {
      if (test)
        setResult(
          await api.testSignInProvider(view.provider, input(), setupToken.trim() || undefined),
        );
      else {
        const saved = await api.saveSignInProvider(
          view.provider,
          input(),
          setupToken.trim() || undefined,
        );
        setSecret("");
        onSaved(saved.provider, saved.bootstrap);
        toast.success("Sign-in settings saved");
        if (config.bootstrap) window.location.href = signInPath(view.provider);
      }
    } catch (err) {
      if (test) setResult({ ok: false, error: errorMessage(err) });
      else toast.error("Couldn't save", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      aria-label={`${SIGN_IN_PROVIDER_LABEL[view.provider]} settings`}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void perform(false);
      }}
    >
      <CopyField label="Redirect URI" value={view.callbackUrl ?? ""} />
      {view.provider === "bitbucket" && (
        <p className={HELP}>
          Create a Bitbucket Cloud OAuth consumer with Account, Email and Workspace membership read
          permissions. Group names are workspace slugs.
        </p>
      )}
      <Labeled label="Button label">
        <input
          className={INPUT}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Labeled>
      <div className="grid sm:grid-cols-2 gap-3">
        <Labeled label="Client ID">
          <input
            required
            className={INPUT}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
        </Labeled>
        <Labeled label="Client secret">
          <input
            required={!view.hasClientSecret && view.source !== "environment"}
            type="password"
            autoComplete="off"
            className={INPUT}
            placeholder={view.hasClientSecret ? "Unchanged" : ""}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Labeled>
      </div>

      {fields.map(([key, label, multiline]) => (
        <Labeled key={key} label={label}>
          {multiline ? (
            <textarea
              className={MONO_AREA}
              value={String(settings[key] ?? "")}
              onChange={(e) => setSettings((s) => ({ ...s, [key]: orNull(e.target.value) }))}
            />
          ) : (
            <input
              className={INPUT}
              value={String(settings[key] ?? "")}
              onChange={(e) => setSettings((s) => ({ ...s, [key]: orNull(e.target.value) }))}
            />
          )}
        </Labeled>
      ))}
      <AccessSection
        draft={access}
        onChange={(p) => setAccess((a) => ({ ...a, ...p }))}
        bootstrap={config.bootstrap}
        organizationName={organizationName}
        onOrganizationName={setOrganizationName}
      />
      {result && <TestResultView result={result} />}
      <div className="flex items-center gap-2">
        <button className={BTN_PRIMARY} type="submit" disabled={busy}>
          {config.bootstrap ? "Save and sign in" : "Save"}
        </button>
        {!config.bootstrap && mode === "settings" && (
          <RemoveButton
            provider={view.provider}
            view={view}
            setupToken={setupToken}
            disabled={busy}
            onRemoved={onRemoved}
          />
        )}
      </div>
    </form>
  );
}
