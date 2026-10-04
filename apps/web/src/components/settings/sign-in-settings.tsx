"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Shield,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  api,
  type DeploymentAdmin,
  type SignInConfig,
  type SignInProviderView,
} from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { BrandIcon, brandFor } from "@/components/brand-icon";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_HEADER,
  BTN_PRIMARY,
  BTN_ROW_DANGER,
  BTN_SECONDARY,
  HELP,
  INPUT,
  LABEL,
  SkeletonCard,
} from "@/components/settings/settings-ui";
import { cn } from "@/lib/utils";

/**
 * How everyone signs in — the Settings → Access → Sign-in card and the setup
 * wizard's Sign-in step share this. It lists every provider (stored in the
 * app or set by the environment), lets a **deployment admin** configure the
 * organization's Google sign-in (client, allowed Google Workspace domains),
 * and manages the deployment admins. While nobody can sign in yet
 * (**bootstrap**), the one-time **setup token** from the API log unlocks the
 * form, and "Save and sign in with Google" makes the first person through
 * the deployment admin. See docs/plans/org-scoping-and-sso.md.
 */

const LIST = "divide-y divide-border rounded-lg border border-border overflow-hidden";

function parseDomains(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function Status({ p }: { p: SignInProviderView }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px]",
        p.enabled ? "text-success" : "text-text-muted",
      )}
    >
      {p.enabled ? (
        <CheckCircle2 className="w-3.5 h-3.5" />
      ) : (
        <XCircle className="w-3.5 h-3.5 opacity-50" />
      )}
      {p.enabled
        ? p.source === "database"
          ? "Configured here"
          : "Set by the environment"
        : "Not configured"}
    </span>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className={LABEL}>{label}</span>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono">
          {value}
        </code>
        <button
          type="button"
          className={BTN_HEADER}
          onClick={() => {
            navigator.clipboard?.writeText(value).then(
              () => toast.success("Copied"),
              () => toast.error("Couldn't copy"),
            );
          }}
          title="Copy"
        >
          <Copy className="w-3.5 h-3.5" /> Copy
        </button>
      </div>
    </div>
  );
}

/** The Google form: client, allowed domains, and — while bootstrapping — the organization. */
function GoogleForm({
  provider,
  config,
  setupToken,
  mode,
  onSaved,
}: {
  provider: SignInProviderView;
  config: SignInConfig;
  setupToken: string;
  mode: "settings" | "wizard";
  onSaved: (view: SignInProviderView, bootstrap: boolean) => void;
}) {
  const [clientId, setClientId] = useState(provider.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [domains, setDomains] = useState(provider.allowedDomains.join(", "));
  const [restrict, setRestrict] = useState(provider.allowedDomains.length > 0 || config.bootstrap);
  const [organizationName, setOrganizationName] = useState("");
  const [saving, setSaving] = useState(false);
  const bootstrap = config.bootstrap;
  const needsSecret = !provider.hasClientSecret || provider.source !== "database";

  const save = async (thenSignIn: boolean) => {
    const allowedDomains = restrict ? parseDomains(domains) : [];
    if (restrict && allowedDomains.length === 0) {
      toast.error("Add at least one domain, or allow anyone with a Google account");
      return;
    }
    if (bootstrap && !setupToken.trim()) {
      toast.error("The setup token is required while nobody can sign in yet");
      return;
    }
    setSaving(true);
    try {
      const res = await api.saveSignInProvider(
        "google",
        {
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          allowedDomains,
          enabled: true,
          ...(bootstrap && organizationName.trim()
            ? { organizationName: organizationName.trim() }
            : {}),
        },
        setupToken.trim() || undefined,
      );
      toast.success("Google sign-in saved");
      setClientSecret("");
      onSaved(res.provider, res.bootstrap);
      if (thenSignIn) window.location.href = "/api/auth/google/login";
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save(bootstrap);
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <CopyField
            label="Redirect URI to register in Google Cloud Console"
            value={provider.callbackUrl}
          />
          <p className={HELP}>
            Create an OAuth client (Web application) in the Google Cloud Console, add this URI under
            Authorized redirect URIs, and paste its client ID and secret here.
          </p>
        </div>
        <div>
          <label className={LABEL}>Client ID</label>
          <input
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="1234-abc.apps.googleusercontent.com"
            className={INPUT + " font-mono"}
          />
        </div>
        <div>
          <label className={LABEL}>Client secret</label>
          <input
            type="password"
            required={needsSecret}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={needsSecret ? "GOCSPX-…" : "Unchanged"}
            className={INPUT}
            autoComplete="off"
          />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className={LABEL}>Who may sign in</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="restrict"
            checked={restrict}
            onChange={() => setRestrict(true)}
            className="mt-1"
          />
          <span>
            Only people from these Google Workspace domains
            <input
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              disabled={!restrict}
              placeholder="acme.com, acme.io"
              className={INPUT + " mt-1.5"}
            />
            <span className={HELP + " block"}>
              Checked on each sign-in against the account's Workspace domain and its verified email.
              Public mail domains (gmail.com, …) are refused.
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="restrict"
            checked={!restrict}
            onChange={() => setRestrict(false)}
          />
          Anyone with a Google account
          {!restrict && (
            <span className="text-[11px] text-warning">
              — every Google user can create an account here
            </span>
          )}
        </label>
      </fieldset>

      {bootstrap && (
        <div>
          <label className={LABEL}>Organization</label>
          <input
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            placeholder="Acme"
            className={INPUT}
          />
          <p className={HELP}>
            The first person to sign in becomes the deployment admin and their workspace takes this
            name; people from the allowed domains join it as members.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button type="submit" disabled={saving} className={BTN_PRIMARY}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {bootstrap ? "Save and sign in with Google" : "Save"}
        </button>
        {!bootstrap && mode === "settings" && provider.source === "database" && (
          <button
            type="button"
            disabled={saving}
            className={BTN_SECONDARY}
            onClick={async () => {
              if (
                !confirm(
                  "Forget the stored Google client? Environment variables, if set, apply again.",
                )
              )
                return;
              try {
                await api.deleteSignInProvider("google");
                toast.success("Stored Google sign-in removed");
                onSaved(
                  {
                    ...provider,
                    source: "none",
                    enabled: false,
                    clientId: null,
                    hasClientSecret: false,
                  },
                  false,
                );
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't remove");
              }
            }}
          >
            Remove
          </button>
        )}
      </div>
    </form>
  );
}

function DeploymentAdmins({
  admins,
  meId,
  onChanged,
}: {
  admins: DeploymentAdmin[];
  meId: string | null;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">Deployment admins</p>
        <p className={HELP}>
          The people who may change how everyone signs in. Separate from workspace roles.
        </p>
      </div>
      <ul className={LIST}>
        {admins.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm truncate">
                {a.displayName}
                {a.id === meId && <span className="text-text-muted"> (you)</span>}
              </p>
              <p className="text-[11px] text-text-muted truncate">
                {a.email}
                {a.fromEnvironment && " · from OPTIO_DEPLOYMENT_ADMINS"}
              </p>
            </div>
            {!a.fromEnvironment && (
              <button
                type="button"
                className={BTN_ROW_DANGER}
                disabled={busy || admins.length === 1}
                title={
                  admins.length === 1 ? "The last deployment admin can't be removed" : "Remove"
                }
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.removeDeploymentAdmin(a.id);
                    onChanged();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Couldn't remove");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!email.trim()) return;
          setBusy(true);
          try {
            await api.addDeploymentAdmin(email.trim());
            setEmail("");
            onChanged();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Couldn't add");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="someone@acme.com (must have signed in once)"
          className={INPUT}
        />
        <button type="submit" disabled={busy || !email.trim()} className={BTN_SECONDARY}>
          Add
        </button>
      </form>
    </div>
  );
}

/**
 * The form both surfaces share. `mode="wizard"` adds the setup-token field
 * and the organization name while bootstrapping; `mode="settings"` adds the
 * deployment admins.
 */
export function SignInSetupForm({
  mode,
  onBootstrapChange,
}: {
  mode: "settings" | "wizard";
  /** Tells the wizard whether sign-in is still unconfigured (Next stays disabled). */
  onBootstrapChange?: (bootstrap: boolean) => void;
}) {
  const { user, userId, authDisabled, loaded } = useCurrentUser();
  const [config, setConfig] = useState<SignInConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState("");
  const [claimToken, setClaimToken] = useState("");

  const load = useCallback(
    (token?: string) =>
      api
        .getSignInConfig(token?.trim() || undefined)
        .then((c) => {
          setConfig(c);
          setError(null);
          onBootstrapChange?.(c.bootstrap);
        })
        .catch((err) =>
          setError(err instanceof Error ? err.message : "Couldn't load sign-in settings"),
        ),
    [onBootstrapChange],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !config) {
    return (
      <p className="text-sm text-error">
        {error} — sign in as a deployment admin, or finish the setup wizard.
      </p>
    );
  }
  if (!config || (!loaded && !config.bootstrap)) {
    return (
      <div className="h-24 skeleton-shimmer rounded-lg" aria-label="Loading sign-in settings" />
    );
  }

  const google = config.providers.find((p) => p.provider === "google")!;
  const others = config.providers.filter((p) => p.provider !== "google");
  const canEdit = config.canEdit || (config.bootstrap && setupToken.trim().length > 0);

  return (
    <div className="space-y-5">
      {authDisabled && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-warning/10 border border-warning/20 text-warning text-xs">
          <Shield className="w-4 h-4 shrink-0" />
          <div>
            <p className="font-medium">Authentication is disabled</p>
            <p className="opacity-80 mt-0.5">
              Set{" "}
              <code className="px-1 py-0.5 bg-warning/10 rounded">OPTIO_AUTH_DISABLED=false</code>{" "}
              to require sign-in; the providers below then apply.
            </p>
          </div>
        </div>
      )}

      {config.bootstrap && (
        <div className="space-y-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
          <div className="flex items-start gap-2 text-sm">
            <KeyRound className="w-4 h-4 mt-0.5 text-primary shrink-0" />
            <div>
              <p className="font-medium">Nobody can sign in yet</p>
              <p className="text-xs text-text-muted mt-0.5">
                Configure your organization's Google sign-in below. The one-time setup token unlocks
                it: the API prints it in its log —{" "}
                <code className="px-1 py-0.5 bg-bg rounded font-mono text-[11px]">
                  kubectl logs deploy/optio-api -n optio | grep &quot;setup token&quot;
                </code>{" "}
                — or it is what <code className="font-mono text-[11px]">OPTIO_SETUP_TOKEN</code> was
                set to.
              </p>
            </div>
          </div>
          <div>
            <label className={LABEL}>Setup token</label>
            <input
              type="password"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              className={INPUT + " font-mono"}
              placeholder="From the API log"
              autoComplete="off"
            />
          </div>
        </div>
      )}

      {/* Google */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="grid place-items-center w-7 h-7 rounded-md border border-border bg-bg-card text-text-muted shrink-0">
              <span className="text-xs font-semibold">G</span>
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">Google</p>
              <p className="text-[11px] text-text-muted">
                {google.allowedDomains.length > 0
                  ? `Only ${google.allowedDomains.join(", ")}`
                  : google.enabled
                    ? "Anyone with a Google account"
                    : "The organization's Google Workspace sign-in"}
              </p>
            </div>
          </div>
          <Status p={google} />
        </div>
        {canEdit ? (
          <GoogleForm
            key={`${google.source}-${google.updatedAt ?? ""}`}
            provider={google}
            config={config}
            setupToken={setupToken}
            mode={mode}
            onSaved={(view, bootstrap) => {
              setConfig((c) =>
                c
                  ? {
                      ...c,
                      bootstrap,
                      providers: c.providers.map((p) => (p.provider === "google" ? view : p)),
                    }
                  : c,
              );
              onBootstrapChange?.(bootstrap);
            }}
          />
        ) : (
          <p className={HELP}>
            {google.source === "environment"
              ? "Set by GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET."
              : "Only a deployment admin can change this."}
            {config.canClaim && !config.bootstrap && (
              <>
                {" "}
                This deployment has no deployment admin yet: claim the role with the setup token.
              </>
            )}
          </p>
        )}
        {config.canClaim && !config.bootstrap && !config.canEdit && (
          <form
            className="flex items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.claimDeploymentAdmin(claimToken.trim());
                toast.success("You are now a deployment admin");
                window.location.reload();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't claim");
              }
            }}
          >
            <input
              type="password"
              value={claimToken}
              onChange={(e) => setClaimToken(e.target.value)}
              placeholder="Setup token (from the API log)"
              className={INPUT + " font-mono"}
              autoComplete="off"
            />
            <button type="submit" disabled={!claimToken.trim()} className={BTN_SECONDARY}>
              <ShieldCheck className="w-3.5 h-3.5" /> Claim
            </button>
          </form>
        )}
      </div>

      {/* Other providers: environment-configured, read-only here */}
      <ul className={LIST}>
        {others.map((p) => {
          const brand = brandFor(p.provider);
          return (
            <li key={p.provider} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="flex items-center gap-3 min-w-0">
                <span className="grid place-items-center w-7 h-7 rounded-md border border-border bg-bg-card text-text-muted shrink-0">
                  {brand ? (
                    <BrandIcon brand={brand} className="w-3.5 h-3.5" />
                  ) : (
                    <KeyRound className="w-3.5 h-3.5" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{p.displayName}</p>
                  <p className="text-[11px] text-text-muted font-mono truncate">
                    {p.provider === "oidc"
                      ? "OIDC_ISSUER_URL / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET"
                      : `${p.provider.toUpperCase()}_OAUTH_CLIENT_ID / ${p.provider.toUpperCase()}_OAUTH_CLIENT_SECRET`}
                  </p>
                </div>
              </div>
              <Status p={p} />
            </li>
          );
        })}
      </ul>

      {mode === "settings" && config.deploymentAdmins && (
        <DeploymentAdmins
          admins={config.deploymentAdmins}
          meId={userId ?? user?.id ?? null}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

/** Settings → Access → Sign-in. */
export function SignInSettings() {
  const [config, setConfig] = useState<SignInConfig | null>(null);
  useEffect(() => {
    api
      .getSignInConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);
  const label = "Sign-in";
  const hint = "How everyone signs in, and who may change it";
  if (config === null) return <SkeletonCard label={label} hint={hint} rows={3} />;
  const enabled = config.providers.filter((p) => p.enabled);
  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={
        config.bootstrap
          ? "nobody can sign in yet"
          : enabled.length
            ? enabled.map((p) => p.displayName).join(", ")
            : "none configured"
      }
      bodyClassName="p-4"
    >
      <SignInSetupForm mode="settings" />
    </SectionCard>
  );
}

export function SignInStepIntro(): ReactNode {
  return (
    <>
      <h2 className="text-lg font-semibold mb-1">Sign-in</h2>
      <p className="text-sm text-text-muted mb-5">
        How your organization signs in to Optio. Google Workspace is the usual choice; GitHub,
        GitLab and generic OIDC can be set with environment variables.
      </p>
    </>
  );
}
