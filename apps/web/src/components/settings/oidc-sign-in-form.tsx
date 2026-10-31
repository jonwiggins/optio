"use client";
import { cloneElement, useId, useState, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FlaskConical,
  Loader2,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  OIDC_PRESETS,
  OIDC_PRESET_LABEL,
  OIDC_PRESET_ISSUER_TEMPLATE,
  type OidcPreset,
  type OidcSettings,
  type LdapSignInSettings,
  type SignInAccessSettings,
  type SignInProviderTestResult,
} from "@optio/shared";
import { api, type SignInProviderView, type SignInConfig } from "@/lib/api-client";
import { GroupsCombobox } from "@/components/ui/groups-combobox";
import { Disclosure } from "@/components/ui/disclosure";
import {
  BTN_HEADER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  HELP,
  INPUT,
  LABEL,
  MONO_AREA,
  Tag,
} from "./settings-ui";
import { cn } from "@/lib/utils";
type Mode = "settings" | "wizard";
const CHECK = "mt-0.5 shrink-0";
export const DEFAULT_DISPLAY_NAME = { oidc: "SSO", ldap: "Corporate account" };
export const SIGN_IN_PROVIDER_LABEL = {
  oidc: "SSO (OpenID Connect)",
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  ldap: "LDAP / Active Directory",
  saml: "SSO (SAML 2.0)",
  gitea: "Gitea / Forgejo",
  bitbucket: "Bitbucket",
};
type SignInProviderName = keyof typeof SIGN_IN_PROVIDER_LABEL;

export interface AccessDraft {
  /** As the provider names them (case kept; the API compares case-insensitively). */
  adminGroups: string[];
  requiredGroups: string[];
  autoJoinOrganization: boolean;
  defaultRole: "member" | "viewer";
  linkByEmail: boolean;
  allowedDomains: string;
  enabled: boolean;
}

export function accessDraftOf(view: SignInProviderView): AccessDraft {
  const s = (view.settings ?? {}) as SignInAccessSettings;
  return {
    adminGroups: s.adminGroups ?? [],
    requiredGroups: s.requiredGroups ?? [],
    autoJoinOrganization: s.autoJoinOrganization ?? false,
    defaultRole: s.defaultRole ?? "member",
    linkByEmail: s.linkByEmail ?? false,
    allowedDomains: view.allowedDomains.join(", "),
    enabled: view.source === "none" ? true : view.enabled,
  };
}

/** Only what differs from the defaults; a save replaces the stored settings whole. */
export function accessSettingsOf(d: AccessDraft): SignInAccessSettings {
  return {
    ...(d.adminGroups.length ? { adminGroups: d.adminGroups } : {}),
    ...(d.requiredGroups.length ? { requiredGroups: d.requiredGroups } : {}),
    ...(d.autoJoinOrganization ? { autoJoinOrganization: true, defaultRole: d.defaultRole } : {}),
    linkByEmail: d.linkByEmail,
  };
}

const OIDC_PRESET_HINTS: Record<OidcPreset, { scopes: string; groupsClaim: string }> = {
  auth0: { scopes: "openid profile email", groupsClaim: "groups" },
  generic: { scopes: "openid profile email", groupsClaim: "groups" },
  keycloak: { scopes: "openid profile email", groupsClaim: "groups" },
  authentik: { scopes: "openid profile email", groupsClaim: "groups" },
  adfs: { scopes: "openid profile email allatclaims", groupsClaim: "groups" },
  entra: { scopes: "openid profile email", groupsClaim: "groups" },
  okta: { scopes: "openid profile email groups", groupsClaim: "groups" },
  zitadel: {
    scopes: "openid profile email urn:zitadel:iam:org:project:roles",
    groupsClaim: "urn:zitadel:iam:org:project:roles",
  },
  authelia: { scopes: "openid profile email groups", groupsClaim: "groups" },
};

const OIDC_PRESET_NOTE: Partial<Record<OidcPreset, string>> = {
  auth0:
    "Add a post-login Action that sets the groups claim on the ID token. Use a namespaced claim if your tenant requires one, and set Groups claim below to match.",
  keycloak:
    "Add a Group Membership mapper to the client (Client scopes → mapper, claim name groups, full group path off) so groups reach Optio.",
  adfs: "Groups come from an issuance transform rule that emits a groups claim; allatclaims carries it in the ID token.",
  entra:
    "Turn on the groups claim under the app registration's Token configuration; Entra sends group object IDs unless configured otherwise.",
  okta: "Add a groups claim to the authorization server (filter the groups to expose) and the groups scope.",
};

export function parseDomains(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** A typed value, or nothing when it is blank (so the API applies its default). */
export function opt(value: string): string | undefined {
  const v = value.trim();
  return v ? v : undefined;
}

export function orNull(value: string): string | null {
  const v = value.trim();
  return v ? v : null;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CopyField({ label, value }: { label: string; value: string }) {
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

/** A label wired to the single control inside it, with optional help below. */
export function Labeled({
  label,
  help,
  className,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  className?: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {cloneElement(children, { id })}
      {help && <p className={HELP}>{help}</p>}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  help,
  tone,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  help?: ReactNode;
  tone?: "warning";
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={CHECK}
      />
      <span className="min-w-0">
        <span className={tone === "warning" ? "text-error" : undefined}>{label}</span>
        {help && (
          <span className={cn(HELP, "block", tone === "warning" && "text-error/80")}>{help}</span>
        )}
      </span>
    </label>
  );
}

function GroupsField({
  label,
  value,
  onChange,
  help,
  search,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  help: ReactNode;
  /** Suggest the directory's groups (needs a signed-in person; off while bootstrapping). */
  search: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <GroupsCombobox
        id={id}
        label={label}
        value={value}
        onChange={onChange}
        search={search}
        qualified={false}
      />
      <p className={HELP}>{help}</p>
    </div>
  );
}

export function AccessSection({
  draft,
  onChange,
  bootstrap,
  organizationName,
  onOrganizationName,
}: {
  draft: AccessDraft;
  onChange: (patch: Partial<AccessDraft>) => void;
  bootstrap: boolean;
  organizationName: string;
  onOrganizationName: (v: string) => void;
}) {
  return (
    <fieldset className="space-y-3 pt-3 border-t border-border">
      <legend className="text-sm font-medium pt-3">Access</legend>
      {bootstrap && (
        // First setup: who runs Optio is the decision that matters most here.
        <div
          className="rounded-lg border border-primary/30 bg-primary/5 p-3"
          data-testid="bootstrap-admin-groups"
        >
          <GroupsField
            label="Admin group(s)"
            value={draft.adminGroups}
            onChange={(adminGroups) => onChange({ adminGroups })}
            search={false}
            help={
              <>
                Members of these directory groups are admitted as admins every time they sign in:
                deployment admins, and admins of the organization workspace. You become one too as
                the first to sign in. Saved with this provider; change it later in Settings →
                Sign-in. No workspace is created per group — workspaces are made by people, and a
                workspace can name the groups it opens to.
              </>
            }
          />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {!bootstrap && (
          <GroupsField
            label="Admin groups"
            value={draft.adminGroups}
            onChange={(adminGroups) => onChange({ adminGroups })}
            search
            help="Members become deployment admins and admins of the organization workspace, as the provider names them. Empty: only whoever completed setup, and whoever they add."
          />
        )}
        <GroupsField
          label="Required groups"
          value={draft.requiredGroups}
          onChange={(requiredGroups) => onChange({ requiredGroups })}
          search={!bootstrap}
          help="Only members of one of these may sign in. Empty: everyone the provider knows."
        />
      </div>
      <Labeled
        label="Allowed email domains"
        help={
          <>
            Only people whose email is from one of these domains may sign in. Empty: any email the
            provider vouches for. Public mail domains (gmail.com, …) are refused.
          </>
        }
      >
        <input
          value={draft.allowedDomains}
          onChange={(e) => onChange({ allowedDomains: e.target.value })}
          placeholder="acme.com, acme.io"
          className={INPUT}
        />
      </Labeled>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Checkbox
          checked={draft.autoJoinOrganization}
          onChange={(autoJoinOrganization) => onChange({ autoJoinOrganization })}
          label="Everyone who signs in joins the organization workspace"
          help="Off: new people get a workspace of their own until an admin adds them."
        />
        <Labeled label="Role on joining">
          <select
            value={draft.defaultRole}
            onChange={(e) =>
              onChange({ defaultRole: e.target.value as AccessDraft["defaultRole"] })
            }
            disabled={!draft.autoJoinOrganization}
            className={INPUT}
          >
            <option value="member">Member — can create and run work</option>
            <option value="viewer">Viewer — read-only</option>
          </select>
        </Labeled>
      </div>
      <Checkbox
        checked={draft.linkByEmail}
        onChange={(linkByEmail) => onChange({ linkByEmail })}
        label="Keep existing accounts by email"
        help="Someone signing in here for the first time whose verified email matches one existing account (from another sign-in method) gets that account, with its work, secrets and role. Turn on only when people can't change their own email at this provider. Off: a new account."
      />
      {bootstrap ? (
        <Labeled
          label="Organization"
          help={
            <>
              The first person to sign in becomes the deployment admin and their workspace takes
              this name. Enable automatic joining above to add later sign-ins.
            </>
          }
        >
          <input
            value={organizationName}
            onChange={(e) => onOrganizationName(e.target.value)}
            placeholder="Acme"
            className={INPUT}
          />
        </Labeled>
      ) : (
        <Checkbox
          checked={draft.enabled}
          onChange={(enabled) => onChange({ enabled })}
          label="Enabled"
          help="Off: the provider stays configured but nobody can sign in with it."
        />
      )}
    </fieldset>
  );
}

function YesNo({ value, unknown }: { value: boolean | null; unknown: string }) {
  if (value === null) return <span className="text-text-muted">unknown — {unknown}</span>;
  return value ? (
    <span className="text-success">yes</span>
  ) : (
    <span className="text-warning">not advertised</span>
  );
}

export function TestResultView({
  result,
  sampleUsername,
}: {
  result: SignInProviderTestResult;
  sampleUsername?: string;
}) {
  if (!result.ok) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 p-3 rounded-lg bg-error/10 border border-error/20 text-error text-xs"
      >
        <XCircle className="w-4 h-4 shrink-0" />
        <p className="whitespace-pre-wrap break-words min-w-0">
          {result.error ?? "The test failed"}
        </p>
      </div>
    );
  }
  const row = (k: string, v: ReactNode) => (
    <div key={k} className="contents">
      <dt className="text-text-muted">{k}</dt>
      <dd className="min-w-0 break-all font-mono">{v}</dd>
    </div>
  );
  return (
    <div
      role="status"
      className="p-3 rounded-lg bg-success/5 border border-success/20 text-xs space-y-2"
    >
      {result.saml && (
        <>
          <p className="font-medium">SAML identity provider verified</p>
          <p>{result.saml.entityId}</p>
          <p>{result.saml.entryPoint}</p>
          {result.saml.certificates.map((c) => (
            <p key={c.fingerprint256}>
              {c.subject} · expires {c.notAfter}
            </p>
          ))}
        </>
      )}
      {result.oidc && (
        <>
          <p className="flex items-center gap-1.5 text-success font-medium">
            <CheckCircle2 className="w-4 h-4" /> Discovery succeeded
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {row("Issuer", result.oidc.issuer)}
            {row("Authorization", result.oidc.authorizationEndpoint)}
            {row("Token", result.oidc.tokenEndpoint)}
            {row(
              "Userinfo",
              result.oidc.userinfoEndpoint ?? <span className="text-text-muted">none</span>,
            )}
            {row("JWKS", result.oidc.jwksUri)}
          </dl>
          <div>
            <span className="text-text-muted">Scopes supported: </span>
            {result.oidc.scopesSupported.length ? (
              <span className="inline-flex flex-wrap gap-1 align-middle">
                {result.oidc.scopesSupported.map((s) => (
                  <Tag key={s}>{s}</Tag>
                ))}
              </span>
            ) : (
              <span className="text-text-muted">not advertised</span>
            )}
          </div>
          <div>
            <span className="text-text-muted">Groups claim advertised: </span>
            <YesNo
              value={result.oidc.groupsClaimAdvertised}
              unknown="the server lists no claims; it may still send it"
            />
          </div>
          <div>
            <span className="text-text-muted">PKCE (S256): </span>
            <YesNo value={result.oidc.pkceSupported} unknown="the server doesn't say" />
          </div>
        </>
      )}{" "}
      {result.ldap && (
        <>
          <p className="flex items-center gap-1.5 text-success font-medium">
            <CheckCircle2 className="w-4 h-4" /> Connected and bound
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {row(
              "Bound as",
              result.ldap.boundAs || <span className="text-text-muted">anonymous</span>,
            )}
            {result.ldap.serverInfo?.vendor && row("Server", result.ldap.serverInfo.vendor)}
            {result.ldap.serverInfo?.namingContexts?.length
              ? row("Naming contexts", result.ldap.serverInfo.namingContexts.join("; "))
              : null}
          </dl>
          {result.ldap.sample ? (
            <div className="pt-1 border-t border-success/20">
              <p className="text-text-muted mb-1">Sample user</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {row("DN", result.ldap.sample.dn)}
                {row("Username", result.ldap.sample.username)}
                {row(
                  "Email",
                  result.ldap.sample.email || <span className="text-text-muted">none</span>,
                )}
                {row(
                  "Display name",
                  result.ldap.sample.displayName || <span className="text-text-muted">none</span>,
                )}
                {row(
                  "Groups",
                  result.ldap.sample.groups.length ? (
                    <span className="inline-flex flex-wrap gap-1">
                      {result.ldap.sample.groups.map((g) => (
                        <Tag key={g}>{g}</Tag>
                      ))}
                    </span>
                  ) : (
                    <span className="text-text-muted">none</span>
                  ),
                )}
              </dl>
            </div>
          ) : sampleUsername?.trim() ? (
            <p className="text-warning">
              No user matched the filter for “{sampleUsername.trim()}”.
            </p>
          ) : (
            <p className="text-text-muted">
              Type a username next to Test to see what the directory returns for that person.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── Shared form plumbing ──────────────────────────────────────────────────

export interface ProviderFormProps {
  view: SignInProviderView;
  config: SignInConfig;
  setupToken: string;
  mode: Mode;
  onSaved: (view: SignInProviderView, bootstrap: boolean) => void;
  onRemoved: () => void;
}

export function RemoveButton({
  provider,
  view,
  setupToken,
  disabled,
  onRemoved,
}: {
  provider: SignInProviderName;
  view: SignInProviderView;
  setupToken: string;
  disabled: boolean;
  onRemoved: () => void;
}) {
  if (view.source !== "database") return null;
  return (
    <button
      type="button"
      disabled={disabled}
      className={BTN_SECONDARY}
      onClick={async () => {
        if (
          !confirm(
            `Forget the stored ${SIGN_IN_PROVIDER_LABEL[provider]} settings? Environment variables, if set, apply again.`,
          )
        )
          return;
        try {
          await api.deleteSignInProvider(provider, setupToken.trim() || undefined);
          toast.success(`${SIGN_IN_PROVIDER_LABEL[provider]} settings removed`);
          onRemoved();
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    >
      <Trash2 className="w-3.5 h-3.5" /> Remove
    </button>
  );
}

export function CaFields({
  caPem,
  insecureSkipVerify,
  onChange,
}: {
  caPem: string;
  insecureSkipVerify: boolean;
  onChange: (patch: { caPem?: string; insecureSkipVerify?: boolean }) => void;
}) {
  return (
    <>
      <Labeled
        label="Certificate authority (PEM, optional)"
        help={
          <>
            The CA that signed the server&apos;s certificate, when it is a private one. Leave empty
            for a certificate the system already trusts.
          </>
        }
      >
        <textarea
          value={caPem}
          onChange={(e) => onChange({ caPem: e.target.value })}
          placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
          rows={4}
          className={MONO_AREA}
          spellCheck={false}
        />
      </Labeled>
      <Checkbox
        checked={insecureSkipVerify}
        onChange={(insecureSkipVerify) => onChange({ insecureSkipVerify })}
        tone="warning"
        label={
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" /> Skip certificate verification
          </span>
        }
        help="Test labs only: anyone on the network could impersonate the server and read every password or token. Paste the CA above instead."
      />
    </>
  );
}

export function displayNameDraft(view: SignInProviderView): string {
  // The API falls back to the generic label when nothing is stored; that's a
  // poor button label, so offer the short default instead.
  return view.displayName === SIGN_IN_PROVIDER_LABEL[view.provider] ? "" : view.displayName;
}

// ── OIDC ──────────────────────────────────────────────────────────────────

interface OidcDraft {
  displayName: string;
  preset: OidcPreset;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  groupsClaim: string;
  emailClaim: string;
  nameClaim: string;
  usernameClaim: string;
  trustEmail: boolean;
  usePkce: boolean;
  tokenAuthMethod: "client_secret_post" | "client_secret_basic";
  caPem: string;
  insecureSkipVerify: boolean;
  access: AccessDraft;
}

function oidcDraftOf(view: SignInProviderView): OidcDraft {
  const s = (view.settings ?? {}) as Partial<OidcSettings>;
  return {
    displayName: displayNameDraft(view),
    preset: s.preset ?? "generic",
    issuerUrl: s.issuerUrl ?? "",
    clientId: view.clientId ?? "",
    clientSecret: "",
    scopes: s.scopes ?? "",
    groupsClaim: s.groupsClaim ?? "",
    emailClaim: s.emailClaim ?? "",
    nameClaim: s.nameClaim ?? "",
    usernameClaim: s.usernameClaim ?? "",
    trustEmail: s.trustEmail ?? false,
    usePkce: s.usePkce ?? true,
    tokenAuthMethod: s.tokenAuthMethod ?? "client_secret_post",
    caPem: s.caPem ?? "",
    insecureSkipVerify: s.insecureSkipVerify ?? false,
    access: accessDraftOf(view),
  };
}

function oidcSettingsOf(d: OidcDraft): OidcSettings {
  return {
    preset: d.preset,
    issuerUrl: d.issuerUrl.trim(),
    scopes: opt(d.scopes),
    groupsClaim: opt(d.groupsClaim),
    emailClaim: opt(d.emailClaim),
    nameClaim: opt(d.nameClaim),
    usernameClaim: opt(d.usernameClaim),
    trustEmail: d.trustEmail,
    usePkce: d.usePkce,
    tokenAuthMethod: d.tokenAuthMethod,
    caPem: orNull(d.caPem),
    insecureSkipVerify: d.insecureSkipVerify,
    ...accessSettingsOf(d.access),
  };
}

export function OidcForm({
  view,
  config,
  setupToken,
  mode,
  onSaved,
  onRemoved,
}: ProviderFormProps) {
  const [d, setD] = useState<OidcDraft>(() => oidcDraftOf(view));
  const [organizationName, setOrganizationName] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SignInProviderTestResult | null>(null);
  const bootstrap = config.bootstrap;
  const secretStored = view.source === "database" && view.hasClientSecret;
  const patch = (p: Partial<OidcDraft>) => setD((cur) => ({ ...cur, ...p }));
  const hints = OIDC_PRESET_HINTS[d.preset];
  const token = setupToken.trim() || undefined;

  const checkRequired = (): boolean => {
    if (!d.issuerUrl.trim() || !d.clientId.trim()) {
      toast.error("The issuer URL and client ID are required");
      return false;
    }
    if (bootstrap && !setupToken.trim()) {
      toast.error("The setup token is required while nobody can sign in yet");
      return false;
    }
    return true;
  };

  const test = async () => {
    if (!checkRequired()) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await api.testSignInProvider(
          "oidc",
          {
            clientId: d.clientId.trim(),
            ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}),
            settings: oidcSettingsOf(d),
          },
          token,
        ),
      );
    } catch (err) {
      setTestResult({ ok: false, error: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!checkRequired()) return;
    setSaving(true);
    try {
      const res = await api.saveSignInProvider(
        "oidc",
        {
          clientId: d.clientId.trim(),
          ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}),
          allowedDomains: parseDomains(d.access.allowedDomains),
          enabled: bootstrap ? true : d.access.enabled,
          displayName: orNull(d.displayName),
          settings: oidcSettingsOf(d),
          ...(bootstrap && organizationName.trim()
            ? { organizationName: organizationName.trim() }
            : {}),
        },
        token,
      );
      toast.success("SSO sign-in saved");
      onSaved(res.provider, res.bootstrap);
      if (bootstrap) window.location.href = "/api/auth/oidc/login";
    } catch (err) {
      toast.error("Couldn't save", { description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || testing;
  return (
    <form
      className="space-y-4"
      aria-label="SSO (OpenID Connect) settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Labeled
          label="Provider"
          help={
            <>
              {OIDC_PRESET_NOTE[d.preset] ??
                "Picks the usual scopes and groups claim; every setting below can still be changed."}
            </>
          }
        >
          <select
            value={d.preset}
            onChange={(e) => patch({ preset: e.target.value as OidcPreset })}
            className={INPUT}
          >
            {OIDC_PRESETS.map((p) => (
              <option key={p} value={p}>
                {OIDC_PRESET_LABEL[p]}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled
          label="Button label"
          help={
            <>
              The login page shows “Sign in with {d.displayName.trim() || DEFAULT_DISPLAY_NAME.oidc}
              ”.
            </>
          }
        >
          <input
            value={d.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
            placeholder={DEFAULT_DISPLAY_NAME.oidc}
            className={INPUT}
          />
        </Labeled>
        <Labeled
          label="Issuer URL"
          className="sm:col-span-2"
          help={
            <>
              <code className="font-mono">&lt;issuer&gt;/.well-known/openid-configuration</code>{" "}
              must exist; Test fetches it.
            </>
          }
        >
          <input
            required
            value={d.issuerUrl}
            onChange={(e) => patch({ issuerUrl: e.target.value })}
            placeholder={OIDC_PRESET_ISSUER_TEMPLATE[d.preset]}
            className={INPUT + " font-mono"}
            spellCheck={false}
          />
        </Labeled>
        <Labeled label="Client ID">
          <input
            required
            value={d.clientId}
            onChange={(e) => patch({ clientId: e.target.value })}
            placeholder="optio"
            className={INPUT + " font-mono"}
            spellCheck={false}
          />
        </Labeled>
        <Labeled label="Client secret">
          <input
            type="password"
            required={!secretStored}
            value={d.clientSecret}
            onChange={(e) => patch({ clientSecret: e.target.value })}
            placeholder={secretStored ? "unchanged" : "From the provider's client settings"}
            className={INPUT}
            autoComplete="off"
          />
        </Labeled>
        {view.callbackUrl && (
          <div className="sm:col-span-2">
            <CopyField
              label="Redirect URI to register with the provider"
              value={view.callbackUrl}
            />
            <p className={HELP}>
              Create a confidential web client at the provider, allow this redirect URI on it, and
              paste its client ID and secret here.
            </p>
          </div>
        )}
        <Labeled label="Scopes" help="Space-separated. Empty: the provider preset's usual scopes.">
          <input
            value={d.scopes}
            onChange={(e) => patch({ scopes: e.target.value })}
            placeholder={hints.scopes}
            className={INPUT + " font-mono"}
            spellCheck={false}
          />
        </Labeled>
        <Labeled
          label="Groups claim"
          help="The claim that carries the person's groups (see Access below)."
        >
          <input
            value={d.groupsClaim}
            onChange={(e) => patch({ groupsClaim: e.target.value })}
            placeholder={hints.groupsClaim}
            className={INPUT + " font-mono"}
            spellCheck={false}
          />
        </Labeled>
      </div>

      <Disclosure open={advanced} onToggle={() => setAdvanced((v) => !v)} label="Advanced">
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Labeled label="Email claim">
              <input
                value={d.emailClaim}
                onChange={(e) => patch({ emailClaim: e.target.value })}
                placeholder="email"
                className={INPUT + " font-mono"}
                spellCheck={false}
              />
            </Labeled>
            <Labeled label="Name claim">
              <input
                value={d.nameClaim}
                onChange={(e) => patch({ nameClaim: e.target.value })}
                placeholder="name"
                className={INPUT + " font-mono"}
                spellCheck={false}
              />
            </Labeled>
            <Labeled label="Username claim">
              <input
                value={d.usernameClaim}
                onChange={(e) => patch({ usernameClaim: e.target.value })}
                placeholder="preferred_username"
                className={INPUT + " font-mono"}
                spellCheck={false}
              />
            </Labeled>
          </div>
          <Checkbox
            checked={d.trustEmail}
            onChange={(trustEmail) => patch({ trustEmail })}
            label="Trust the email address"
            help="Treat the email as verified when the provider sends no email_verified claim — most self-hosted providers don't. An email the provider marks unverified stays unverified. Off: people without a verified email can't be checked against the allowed domains and are refused."
          />
          <Checkbox
            checked={d.usePkce}
            onChange={(usePkce) => patch({ usePkce })}
            label="PKCE (S256)"
            help="Proof Key for Code Exchange on the authorization request. Keep on unless the provider rejects it."
          />
          <Labeled
            label="Client authentication"
            className="sm:w-1/2"
            help="How the client secret reaches the token endpoint."
          >
            <select
              value={d.tokenAuthMethod}
              onChange={(e) =>
                patch({ tokenAuthMethod: e.target.value as OidcDraft["tokenAuthMethod"] })
              }
              className={INPUT}
            >
              <option value="client_secret_post">
                Secret in the request body (client_secret_post)
              </option>
              <option value="client_secret_basic">HTTP Basic (client_secret_basic)</option>
            </select>
          </Labeled>
          <CaFields
            caPem={d.caPem}
            insecureSkipVerify={d.insecureSkipVerify}
            onChange={(p) => patch(p)}
          />
        </div>
      </Disclosure>

      <AccessSection
        draft={d.access}
        onChange={(p) => setD((cur) => ({ ...cur, access: { ...cur.access, ...p } }))}
        bootstrap={bootstrap}
        organizationName={organizationName}
        onOrganizationName={setOrganizationName}
      />

      <div className="space-y-2 pt-3 border-t border-border">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            className={BTN_SECONDARY}
            onClick={() => void test()}
          >
            {testing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FlaskConical className="w-3.5 h-3.5" />
            )}
            Test
          </button>
          <span className={HELP + " mt-0"}>
            Fetches the issuer&apos;s discovery document with the settings as typed. Nothing is
            saved.
          </span>
        </div>
        {testResult && <TestResultView result={testResult} />}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {bootstrap ? "Save and sign in with SSO" : "Save"}
        </button>
        {!bootstrap && mode === "settings" && (
          <RemoveButton
            provider="oidc"
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
