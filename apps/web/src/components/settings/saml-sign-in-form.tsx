"use client";
import { useState } from "react";
import { toast } from "sonner";
import type { AnySignInSettings, SignInProviderTestResult } from "@optio/shared";
import { api } from "@/lib/api-client";
import { INPUT, MONO_AREA, HELP, BTN_PRIMARY, BTN_SECONDARY } from "./settings-ui";
import {
  SIGN_IN_PROVIDER_LABEL,
  accessDraftOf,
  accessSettingsOf,
  parseDomains,
  orNull,
  errorMessage,
  Labeled,
  Checkbox,
  AccessSection,
  TestResultView,
  RemoveButton,
  CopyField,
  type ProviderFormProps,
} from "./oidc-sign-in-form";
export function SamlForm({
  view,
  config,
  setupToken,
  mode,
  onSaved,
  onRemoved,
}: ProviderFormProps) {
  const [clientId] = useState(view.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [displayName, setDisplayName] = useState(view.displayName);
  const [settings, setSettings] = useState<Record<string, unknown>>({ ...(view.settings ?? {}) });
  const [access, setAccess] = useState(() => accessDraftOf(view));
  const [organizationName, setOrganizationName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SignInProviderTestResult | null>(null);
  const saml = view.provider === "saml";
  const fields: Array<[string, string, boolean?]> = [
    ["metadataUrl", "Identity provider metadata URL"],
    ["metadataXml", "Identity provider metadata XML", true],
    ["entryPoint", "Single sign-on URL (when not supplied by metadata)"],
    ["idpEntityId", "Identity provider entity ID"],
    ["idpCert", "Identity provider signing certificate (PEM)", true],
    ["spEntityId", "Service provider entity ID (optional)"],
    ["idAttribute", "Stable ID attribute (default: NameID)"],
    ["emailAttribute", "Email attribute (default: email)"],
    ["nameAttribute", "Name attribute (default: displayName)"],
    ["usernameAttribute", "Username attribute (default: username)"],
    ["groupsAttribute", "Groups attribute (default: groups)"],
    ["caPem", "Metadata server CA certificate (optional)", true],
  ];
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
        if (config.bootstrap) window.location.href = `/api/auth/${view.provider}/login`;
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
      <CopyField
        label={saml ? "Assertion consumer service URL" : "Redirect URI"}
        value={view.callbackUrl ?? ""}
      />
      {saml && (
        <>
          <CopyField label="Service provider metadata URL" value={view.metadataUrl ?? ""} />
          <p className={HELP}>
            Use metadata XML or a metadata URL, or enter the single sign-on URL, entity ID and
            signing certificate. Assertions must be signed. Register the service provider metadata
            with your identity provider.
          </p>
        </>
      )}
      <Labeled label="Button label">
        <input
          className={INPUT}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Labeled>
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
      {saml && (
        <Checkbox
          checked={settings.wantAuthnResponseSigned === true}
          onChange={(v) => setSettings((s) => ({ ...s, wantAuthnResponseSigned: v }))}
          label="Also require the whole response to be signed"
        />
      )}
      {saml && (
        <Checkbox
          checked={settings.trustEmail === true}
          onChange={(v) => setSettings((s) => ({ ...s, trustEmail: v }))}
          label="Trust the identity provider's email addresses"
          help="Treat the identity provider's email attributes as verified — only when people can't change their own at the identity provider. Then a listed OPTIO_DEPLOYMENT_ADMINS address, joining workspaces by email domain and (with Keep existing accounts) linking accounts count it. Off: the address still decides the allowed domains here, but grants nothing by email."
        />
      )}
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
        {saml && (
          <button
            className={BTN_SECONDARY}
            type="button"
            disabled={busy}
            onClick={() => void perform(true)}
          >
            Test metadata
          </button>
        )}
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
