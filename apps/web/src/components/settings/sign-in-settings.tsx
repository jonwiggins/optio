"use client";

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FlaskConical,
  KeyRound,
  Loader2,
  Shield,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  OIDC_PRESETS,
  OIDC_PRESET_LABEL,
  OIDC_PRESET_ISSUER_TEMPLATE,
  type AnySignInSettings,
  SIGN_IN_PROVIDER_LABEL,
  type LdapSignInSettings,
  type OidcPreset,
  type OidcSettings,
  type PublicSignInProvider,
  type SignInAccessSettings,
  type SignInProviderName,
  type SignInProviderTestResult,
  type SignInProviderView,
} from "@optio/shared";
import { api, type DeploymentAdmin, type SignInConfig } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { BrandIcon, brandFor } from "@/components/brand-icon";
import { LdapLoginForm } from "@/components/ldap-login-form";
import { GroupsCombobox } from "@/components/ui/groups-combobox";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { Disclosure } from "@/components/ui/disclosure";
import {
  BTN_HEADER,
  BTN_PRIMARY,
  BTN_ROW_DANGER,
  BTN_SECONDARY,
  HELP,
  INPUT,
  LABEL,
  MONO_AREA,
  SkeletonCard,
  Tag,
} from "@/components/settings/settings-ui";
import { cn } from "@/lib/utils";

/**
 * How everyone signs in — the Settings → Access → Sign-in card and the setup
 * wizard's Sign-in step share this. It lists every provider (stored in the
 * app or set by the environment) and lets a **deployment admin** configure
 * the ones the app can store: the organization's **Google** sign-in (client,
 * allowed Google Workspace domains), **SSO (OpenID Connect)** — Keycloak,
 * Authentik, ADFS, Entra ID, Okta, Zitadel, Authelia, anything standard — and
 * **LDAP / Active Directory** (a username + password form), the last two
 * tested against the server before saving. GitHub and GitLab come from the
 * environment. It also manages the deployment admins. While nobody can sign
 * in yet (**bootstrap**), the one-time **setup token** from the API log
 * unlocks the editor, and the first sign-in makes that person the deployment
 * admin. See docs/sign-in.md.
 */

type Mode = "settings" | "wizard";

const LIST = "divide-y divide-border rounded-lg border border-border overflow-hidden";
const CHECK = "mt-0.5 shrink-0";

const DEFAULT_DISPLAY_NAME: Record<"oidc" | "ldap", string> = {
  oidc: "SSO",
  ldap: "Corporate account",
};

/** What the environment would set (shown when the person may not edit). */
const ENV_HINT: Record<SignInProviderName, string> = {
  google: "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET",
  github: "GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET (or the GitHub App's client)",
  gitlab: "GITLAB_OAUTH_CLIENT_ID / GITLAB_OAUTH_CLIENT_SECRET",
  oidc: "OIDC_ISSUER_URL / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET",
  ldap: "LDAP_URL / LDAP_BIND_DN / LDAP_BIND_PASSWORD / LDAP_USER_BASE_DN",
  bitbucket: "BITBUCKET_OAUTH_CLIENT_ID / BITBUCKET_OAUTH_CLIENT_SECRET",
  gitea: "GITEA_OAUTH_BASE_URL / GITEA_OAUTH_CLIENT_ID / GITEA_OAUTH_CLIENT_SECRET",
  saml: "SAML_METADATA_URL or SAML_ENTRY_POINT / SAML_IDP_CERT",
};

/** What a preset implies when scopes / the groups claim are left empty (mirrors the API). */
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

const DEFAULT_USER_FILTER = "(|(sAMAccountName={{username}})(uid={{username}})(mail={{username}}))";
const DEFAULT_GROUP_FILTER = "(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))";

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

/** A typed value, or nothing when it is blank (so the API applies its default). */
function opt(value: string): string | undefined {
  const v = value.trim();
  return v ? v : undefined;
}

function orNull(value: string): string | null {
  const v = value.trim();
  return v ? v : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
        : p.source === "database"
          ? "Configured here, disabled"
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

/** A label wired to the single control inside it, with optional help below. */
function Labeled({
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

function Checkbox({
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

// ── Access (shared by both providers) ─────────────────────────────────────

interface AccessDraft {
  /** As the provider names them (case kept; the API compares case-insensitively). */
  adminGroups: string[];
  requiredGroups: string[];
  autoJoinOrganization: boolean;
  defaultRole: "member" | "viewer";
  linkByEmail: boolean;
  allowedDomains: string;
  enabled: boolean;
}

function accessDraftOf(view: SignInProviderView): AccessDraft {
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

function accessSettingsOf(d: AccessDraft): SignInAccessSettings {
  return {
    adminGroups: d.adminGroups,
    requiredGroups: d.requiredGroups,
    autoJoinOrganization: d.autoJoinOrganization,
    defaultRole: d.defaultRole,
    linkByEmail: d.linkByEmail,
  };
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
      <GroupsCombobox id={id} label={label} value={value} onChange={onChange} search={search} />
      <p className={HELP}>{help}</p>
    </div>
  );
}

function AccessSection({
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

// ── Test results ──────────────────────────────────────────────────────────

function YesNo({ value, unknown }: { value: boolean | null; unknown: string }) {
  if (value === null) return <span className="text-text-muted">unknown — {unknown}</span>;
  return value ? (
    <span className="text-success">yes</span>
  ) : (
    <span className="text-warning">not advertised</span>
  );
}

function TestResultView({
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
      )}
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

interface ProviderFormProps {
  view: SignInProviderView;
  config: SignInConfig;
  setupToken: string;
  mode: Mode;
  onSaved: (view: SignInProviderView, bootstrap: boolean) => void;
  onRemoved: () => void;
}

function RemoveButton({
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

function CaFields({
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

function displayNameDraft(view: SignInProviderView): string {
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

function OidcForm({ view, config, setupToken, mode, onSaved, onRemoved }: ProviderFormProps) {
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

// ── LDAP ──────────────────────────────────────────────────────────────────

interface LdapDraft {
  displayName: string;
  url: string;
  startTls: boolean;
  bindDn: string;
  bindPassword: string;
  userBaseDn: string;
  userFilter: string;
  usernameAttribute: string;
  emailAttribute: string;
  displayNameAttribute: string;
  groupMode: "memberOf" | "search";
  groupBaseDn: string;
  groupFilter: string;
  usernameLabel: string;
  caPem: string;
  insecureSkipVerify: boolean;
  access: AccessDraft;
}

function ldapDraftOf(view: SignInProviderView): LdapDraft {
  const s = (view.settings ?? {}) as Partial<LdapSignInSettings>;
  return {
    displayName: displayNameDraft(view),
    url: s.url ?? "",
    startTls: s.startTls ?? false,
    bindDn: s.bindDn ?? "",
    bindPassword: "",
    userBaseDn: s.userBaseDn ?? "",
    userFilter: s.userFilter ?? "",
    usernameAttribute: s.usernameAttribute ?? "",
    emailAttribute: s.emailAttribute ?? "",
    displayNameAttribute: s.displayNameAttribute ?? "",
    groupMode: s.groupMode ?? "memberOf",
    groupBaseDn: s.groupBaseDn ?? "",
    groupFilter: s.groupFilter ?? "",
    usernameLabel: s.usernameLabel ?? "",
    caPem: s.caPem ?? "",
    insecureSkipVerify: s.insecureSkipVerify ?? false,
    access: accessDraftOf(view),
  };
}

function ldapSettingsOf(d: LdapDraft): LdapSignInSettings {
  const search = d.groupMode === "search";
  return {
    url: d.url.trim(),
    startTls: d.startTls,
    caPem: orNull(d.caPem),
    insecureSkipVerify: d.insecureSkipVerify,
    bindDn: orNull(d.bindDn),
    userBaseDn: d.userBaseDn.trim(),
    userFilter: orNull(d.userFilter),
    usernameAttribute: orNull(d.usernameAttribute),
    emailAttribute: orNull(d.emailAttribute),
    displayNameAttribute: orNull(d.displayNameAttribute),
    groupMode: d.groupMode,
    groupBaseDn: search ? orNull(d.groupBaseDn) : null,
    groupFilter: search ? orNull(d.groupFilter) : null,
    usernameLabel: orNull(d.usernameLabel),
    ...accessSettingsOf(d.access),
  };
}

function LdapForm({
  view,
  config,
  setupToken,
  mode,
  onSaved,
  onRemoved,
  onSignIn,
}: ProviderFormProps & {
  /** Bootstrap: the saved provider, so the person can sign in right here. */
  onSignIn: (provider: PublicSignInProvider) => void;
}) {
  const [d, setD] = useState<LdapDraft>(() => ldapDraftOf(view));
  const [organizationName, setOrganizationName] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [sampleUsername, setSampleUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SignInProviderTestResult | null>(null);
  const bootstrap = config.bootstrap;
  const secretStored = view.source === "database" && view.hasClientSecret;
  const patch = (p: Partial<LdapDraft>) => setD((cur) => ({ ...cur, ...p }));
  const token = setupToken.trim() || undefined;

  const checkRequired = (): boolean => {
    if (!d.url.trim() || !d.userBaseDn.trim()) {
      toast.error("The server URL and user base DN are required");
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
          "ldap",
          {
            ...(d.bindPassword ? { clientSecret: d.bindPassword } : {}),
            settings: ldapSettingsOf(d),
            ...(sampleUsername.trim() ? { sampleUsername: sampleUsername.trim() } : {}),
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
        "ldap",
        {
          ...(d.bindPassword ? { clientSecret: d.bindPassword } : {}),
          allowedDomains: parseDomains(d.access.allowedDomains),
          enabled: bootstrap ? true : d.access.enabled,
          displayName: orNull(d.displayName),
          settings: ldapSettingsOf(d),
          ...(bootstrap && organizationName.trim()
            ? { organizationName: organizationName.trim() }
            : {}),
        },
        token,
      );
      toast.success("LDAP sign-in saved");
      onSaved(res.provider, res.bootstrap);
      if (bootstrap) {
        const settings = res.provider.settings as LdapSignInSettings | null;
        onSignIn({
          name: "ldap",
          displayName: res.provider.displayName,
          method: "password",
          usernameLabel: settings?.usernameLabel ?? null,
        });
      }
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
      aria-label="LDAP / Active Directory settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Labeled label="Name" help="What the login page calls this sign-in.">
          <input
            value={d.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
            placeholder={DEFAULT_DISPLAY_NAME.ldap}
            className={INPUT}
          />
        </Labeled>
        <Labeled
          label="Username label"
          help="Shown above the username field (“Corporate account”, “Windows login”)."
        >
          <input
            value={d.usernameLabel}
            onChange={(e) => patch({ usernameLabel: e.target.value })}
            placeholder="Username"
            className={INPUT}
          />
        </Labeled>
        <Labeled
          label="Server URL"
          className="sm:col-span-2"
          help={
            <>
              <code className="font-mono">ldaps://</code> for TLS, or{" "}
              <code className="font-mono">ldap://</code> with STARTTLS. Plain{" "}
              <code className="font-mono">ldap://</code> sends passwords in the clear.
            </>
          }
        >
          <input
            required
            value={d.url}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder="ldaps://ad.example.com:636"
            className={INPUT + " font-mono"}
            spellCheck={false}
          />
        </Labeled>
        <div className="sm:col-span-2">
          <Checkbox
            checked={d.startTls}
            onChange={(startTls) => patch({ startTls })}
            label="STARTTLS"
            help="Upgrade a plain ldap:// connection to TLS before binding."
          />
        </div>
        <Labeled
          label="Bind DN"
          help="A read-only service account that looks people up. Empty: anonymous bind."
        >
          <input
            value={d.bindDn}
            onChange={(e) => patch({ bindDn: e.target.value })}
            placeholder="CN=optio,OU=Service Accounts,DC=example,DC=com"
            className={INPUT + " font-mono"}
            spellCheck={false}
          />
        </Labeled>
        <Labeled label="Bind password">
          <input
            type="password"
            value={d.bindPassword}
            onChange={(e) => patch({ bindPassword: e.target.value })}
            placeholder={secretStored ? "unchanged" : "The service account's password"}
            className={INPUT}
            autoComplete="off"
          />
        </Labeled>
        <Labeled
          label="User base DN"
          className="sm:col-span-2"
          help="Where people are searched for (subtree)."
        >
          <input
            required
            value={d.userBaseDn}
            onChange={(e) => patch({ userBaseDn: e.target.value })}
            placeholder="OU=People,DC=example,DC=com"
            className={INPUT + " font-mono"}
            spellCheck={false}
          />
        </Labeled>
        <Labeled
          label="User filter"
          className="sm:col-span-2"
          help={
            <>
              <code className="font-mono">{"{{username}}"}</code> is what the person typed. Empty:
              the default matches sAMAccountName, uid or mail.
            </>
          }
        >
          <input
            value={d.userFilter}
            onChange={(e) => patch({ userFilter: e.target.value })}
            placeholder={DEFAULT_USER_FILTER}
            className={INPUT + " font-mono"}
            spellCheck={false}
          />
        </Labeled>
      </div>

      <Disclosure open={advanced} onToggle={() => setAdvanced((v) => !v)} label="Advanced">
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Labeled label="Username attribute">
              <input
                value={d.usernameAttribute}
                onChange={(e) => patch({ usernameAttribute: e.target.value })}
                placeholder="sAMAccountName, then uid"
                className={INPUT + " font-mono"}
                spellCheck={false}
              />
            </Labeled>
            <Labeled label="Email attribute">
              <input
                value={d.emailAttribute}
                onChange={(e) => patch({ emailAttribute: e.target.value })}
                placeholder="mail"
                className={INPUT + " font-mono"}
                spellCheck={false}
              />
            </Labeled>
            <Labeled label="Display name attribute">
              <input
                value={d.displayNameAttribute}
                onChange={(e) => patch({ displayNameAttribute: e.target.value })}
                placeholder="displayName, then cn"
                className={INPUT + " font-mono"}
                spellCheck={false}
              />
            </Labeled>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Labeled
              label="Groups"
              help="memberOf suits Active Directory; search suits OpenLDAP and directories without it."
            >
              <select
                value={d.groupMode}
                onChange={(e) => patch({ groupMode: e.target.value as LdapDraft["groupMode"] })}
                className={INPUT}
              >
                <option value="memberOf">From the user&apos;s memberOf attribute</option>
                <option value="search">By searching the groups</option>
              </select>
            </Labeled>
            {d.groupMode === "search" && (
              <>
                <Labeled label="Group base DN" help="Empty: the user base DN.">
                  <input
                    value={d.groupBaseDn}
                    onChange={(e) => patch({ groupBaseDn: e.target.value })}
                    placeholder="OU=Groups,DC=example,DC=com"
                    className={INPUT + " font-mono"}
                    spellCheck={false}
                  />
                </Labeled>
                <Labeled
                  label="Group filter"
                  className="sm:col-span-2"
                  help={
                    <>
                      <code className="font-mono">{"{{dn}}"}</code> and{" "}
                      <code className="font-mono">{"{{username}}"}</code> are the person&apos;s.
                    </>
                  }
                >
                  <input
                    value={d.groupFilter}
                    onChange={(e) => patch({ groupFilter: e.target.value })}
                    placeholder={DEFAULT_GROUP_FILTER}
                    className={INPUT + " font-mono"}
                    spellCheck={false}
                  />
                </Labeled>
              </>
            )}
          </div>
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
        <div className="flex flex-wrap items-center gap-2">
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
          <input
            value={sampleUsername}
            onChange={(e) => setSampleUsername(e.target.value)}
            placeholder="Sample username to look up (optional)"
            aria-label="Sample username"
            className={INPUT + " sm:max-w-xs"}
            autoComplete="off"
          />
        </div>
        <p className={HELP + " mt-0"}>
          Connects and binds with the settings as typed, then looks the sample user up to show what
          the directory returns. Nothing is saved.
        </p>
        {testResult && <TestResultView result={testResult} sampleUsername={sampleUsername} />}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {bootstrap ? "Save and sign in" : "Save"}
        </button>
        {!bootstrap && mode === "settings" && (
          <RemoveButton
            provider="ldap"
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

// ── Deployment admins ─────────────────────────────────────────────────────

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
          The people who may change how everyone signs in. Separate from workspace roles; members of
          a provider&apos;s admin groups are added as they sign in.
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

// ── Google ──────────────────────────────────────────────────────────────────

/** The Google form: client, allowed domains, and — while bootstrapping — the organization. */
function GoogleForm({ view, config, setupToken, mode, onSaved, onRemoved }: ProviderFormProps) {
  const [clientId, setClientId] = useState(view.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [domains, setDomains] = useState(view.allowedDomains.join(", "));
  const [restrict, setRestrict] = useState(view.allowedDomains.length > 0 || config.bootstrap);
  const [organizationName, setOrganizationName] = useState("");
  const [saving, setSaving] = useState(false);
  const bootstrap = config.bootstrap;
  const needsSecret = !view.hasClientSecret || view.source !== "database";

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
      toast.error("Couldn't save", { description: errorMessage(err) });
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
            value={view.callbackUrl ?? ""}
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
            name="google-restrict"
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
            name="google-restrict"
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
        {!bootstrap && mode === "settings" && (
          <RemoveButton
            provider="google"
            view={view}
            setupToken={setupToken}
            disabled={saving}
            onRemoved={onRemoved}
          />
        )}
      </div>
    </form>
  );
}

/** Additional redirect providers share the same access controls. */
function AdditionalProviderForm({
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
  const saml = view.provider === "saml";
  const fields: Array<[string, string, boolean?]> = saml
    ? [
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
      ]
    : view.provider === "gitea"
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
      {!saml && (
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
      )}
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

// ── The shared form ───────────────────────────────────────────────────────

/** The provider's mark: its brand where there is one. */
function ProviderIcon({ provider }: { provider: SignInProviderName }) {
  const brand = brandFor(provider);
  return (
    <span className="grid place-items-center w-7 h-7 rounded-md border border-border bg-bg-card text-text-muted shrink-0">
      {brand ? (
        <BrandIcon brand={brand} className="w-3.5 h-3.5" />
      ) : provider === "google" ? (
        <span className="text-xs font-semibold">G</span>
      ) : (
        <KeyRound className="w-3.5 h-3.5" />
      )}
    </span>
  );
}

/** A one-line description of what's configured, under the provider's name. */
function providerCaption(p: SignInProviderView): string {
  if (p.provider === "google") {
    return p.allowedDomains.length > 0
      ? `Only ${p.allowedDomains.join(", ")}`
      : p.enabled
        ? "Anyone with a Google account"
        : "The organization's Google Workspace sign-in";
  }
  if (p.provider === "github" || p.provider === "gitlab") {
    return `Sign-in with a ${p.provider === "github" ? "GitHub" : "GitLab"} account`;
  }
  if (p.provider === "oidc") {
    const issuer = (p.settings as OidcSettings | null)?.issuerUrl;
    return issuer || "The organization's single sign-on";
  }
  if (p.provider === "saml") return "SAML 2.0 with signed assertions";
  if (p.provider === "gitea") return "Sign in with a Gitea or Forgejo account";
  if (p.provider === "bitbucket") return "Sign in with a Bitbucket Cloud account";
  const url = (p.settings as LdapSignInSettings | null)?.url;
  return url || "A username and password checked against the directory";
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
  mode: Mode;
  /** Tells the wizard whether sign-in is still unconfigured (Next stays disabled). */
  onBootstrapChange?: (bootstrap: boolean) => void;
}) {
  const { user, userId, authDisabled, loaded } = useCurrentUser();
  const [config, setConfig] = useState<SignInConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState("");
  const [claimToken, setClaimToken] = useState("");
  const [tab, setTab] = useState<SignInProviderName | null>(null);
  /** Bootstrap with LDAP: the provider just saved, so the first sign-in can happen right here. */
  const [ldapSignIn, setLdapSignIn] = useState<PublicSignInProvider | null>(null);

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

  const providers = [...config.providers].sort((a, b) =>
    SIGN_IN_PROVIDER_LABEL[a.provider].localeCompare(SIGN_IN_PROVIDER_LABEL[b.provider]),
  );
  // The ones the app can store get a tab each; GitHub and GitLab are listed
  // under them, read-only (the environment configures them).
  const editable = providers.filter((p) => p.configurable);
  const envOnly = providers.filter((p) => !p.configurable);
  const current =
    editable.find((p) => p.provider === (tab ?? "")) ??
    editable.find((p) => p.enabled) ??
    editable.find((p) => p.provider === "google") ??
    editable.find((p) => p.provider === config.providers[0]?.provider) ??
    editable[0];
  const canEdit = config.canEdit || (config.bootstrap && setupToken.trim().length > 0);
  // While Google is the only provider in use, the form keeps its familiar
  // layout: Google's form, then every other provider as a row (one the app can
  // store has Set up). The provider tabs take over once another provider is
  // stored or enabled, or Set up was clicked.
  const google = editable.find((p) => p.provider === "google");
  const othersInUse = editable.some(
    (p) => p.provider !== "google" && (p.enabled || p.source !== "none"),
  );
  const tabbed = tab !== null || othersInUse || !google;

  const replaceProvider = (view: SignInProviderView, bootstrap: boolean) => {
    setConfig((c) =>
      c
        ? {
            ...c,
            bootstrap,
            // The setup token that just saved keeps working until a deployment admin exists.
            canEdit: c.canEdit || c.bootstrap,
            providers: c.providers.map((p) => (p.provider === view.provider ? view : p)),
          }
        : c,
    );
    onBootstrapChange?.(bootstrap);
  };

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
                Configure a sign-in provider below. The one-time setup token unlocks it: the API
                prints it in its log —{" "}
                <code className="px-1 py-0.5 bg-bg rounded font-mono text-[11px]">
                  kubectl logs deploy/optio-api -n optio | grep &quot;setup token&quot;
                </code>{" "}
                — or it is what <code className="font-mono text-[11px]">OPTIO_SETUP_TOKEN</code> was
                set to.
              </p>
            </div>
          </div>
          <Labeled label="Setup token">
            <input
              type="password"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              className={INPUT + " font-mono"}
              placeholder="From the API log"
              autoComplete="off"
            />
          </Labeled>
        </div>
      )}

      {ldapSignIn && (
        <div className="space-y-3 p-4 rounded-lg border border-primary/30 bg-primary/5">
          <div>
            <p className="text-sm font-medium">Sign in to finish setting up</p>
            <p className={HELP}>
              The first person to sign in becomes the deployment admin and their workspace becomes
              the organization&apos;s. Sign in with the {ldapSignIn.displayName} account you want to
              hold that role.
            </p>
          </div>
          <LdapLoginForm provider={ldapSignIn} />
        </div>
      )}

      {canEdit && google && !tabbed ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <ProviderIcon provider="google" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{google.displayName}</p>
                <p className="text-[11px] text-text-muted truncate">{providerCaption(google)}</p>
              </div>
            </div>
            <Status p={google} />
          </div>
          {google.source === "environment" && (
            <p className={HELP}>
              Set by the environment ({ENV_HINT.google}). Saving here stores a copy that takes
              precedence; Remove goes back to the environment.
            </p>
          )}
          <GoogleForm
            key={`google-${google.source}-${google.updatedAt ?? ""}`}
            view={google}
            config={config}
            setupToken={setupToken}
            mode={mode}
            onSaved={replaceProvider}
            onRemoved={() => void load(setupToken)}
          />
          <ul className={LIST} aria-label="Other sign-in providers">
            {config.providers
              .filter((p) => p.provider !== "google")
              .map((p) => (
                <li
                  key={p.provider}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <ProviderIcon provider={p.provider} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{p.displayName}</p>
                      <p className="text-[11px] text-text-muted font-mono truncate">
                        {ENV_HINT[p.provider]}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Status p={p} />
                    {p.configurable && (
                      <button
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={() => setTab(p.provider)}
                        aria-label={`Set up ${p.displayName}`}
                      >
                        Set up
                      </button>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        </div>
      ) : canEdit && current ? (
        <div className="space-y-4">
          <Segmented
            value={current.provider}
            onChange={(v) => setTab(v)}
            options={editable.map((p) => ({
              value: p.provider,
              label: SIGN_IN_PROVIDER_LABEL[p.provider],
              icon: p.enabled ? <CheckCircle2 className="w-3.5 h-3.5" /> : undefined,
            }))}
            aria-label="Sign-in provider"
            wrap
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <ProviderIcon provider={current.provider} />
              <div className="min-w-0">
                <p className="text-sm font-medium">{current.displayName}</p>
                <p className="text-[11px] text-text-muted truncate">{providerCaption(current)}</p>
              </div>
            </div>
            <Status p={current} />
          </div>
          {current.source === "environment" && (
            <p className={HELP}>
              Set by the environment ({ENV_HINT[current.provider]}). Saving here stores a copy that
              takes precedence; Remove goes back to the environment.
            </p>
          )}
          {current.provider === "google" ? (
            <GoogleForm
              key={`google-${current.source}-${current.updatedAt ?? ""}`}
              view={current}
              config={config}
              setupToken={setupToken}
              mode={mode}
              onSaved={replaceProvider}
              onRemoved={() => void load(setupToken)}
            />
          ) : current.provider === "oidc" ? (
            <OidcForm
              key={`oidc-${current.source}-${current.updatedAt ?? ""}`}
              view={current}
              config={config}
              setupToken={setupToken}
              mode={mode}
              onSaved={replaceProvider}
              onRemoved={() => void load(setupToken)}
            />
          ) : current.provider === "ldap" ? (
            <LdapForm
              key={`ldap-${current.source}-${current.updatedAt ?? ""}`}
              view={current}
              config={config}
              setupToken={setupToken}
              mode={mode}
              onSaved={replaceProvider}
              onRemoved={() => void load(setupToken)}
              onSignIn={setLdapSignIn}
            />
          ) : (
            <AdditionalProviderForm
              key={`${current.provider}-${current.updatedAt ?? ""}`}
              view={current}
              config={config}
              setupToken={setupToken}
              mode={mode}
              onSaved={replaceProvider}
              onRemoved={() => void load(setupToken)}
            />
          )}
          {envOnly.length > 0 && (
            <ul className={LIST} aria-label="Providers set by the environment">
              {envOnly.map((p) => (
                <li
                  key={p.provider}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <ProviderIcon provider={p.provider} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{p.displayName}</p>
                      <p className="text-[11px] text-text-muted font-mono truncate">
                        {ENV_HINT[p.provider]}
                      </p>
                    </div>
                  </div>
                  <Status p={p} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <ul className={LIST}>
            {providers.map((p) => (
              <li key={p.provider} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <ProviderIcon provider={p.provider} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {p.displayName}
                      {p.displayName !== SIGN_IN_PROVIDER_LABEL[p.provider] && (
                        <span className="text-text-muted font-normal">
                          {" "}
                          · {SIGN_IN_PROVIDER_LABEL[p.provider]}
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-text-muted font-mono truncate">
                      {p.source === "environment" || !p.configurable
                        ? ENV_HINT[p.provider]
                        : providerCaption(p)}
                    </p>
                  </div>
                </div>
                <Status p={p} />
              </li>
            ))}
          </ul>
          <p className={HELP}>
            {config.bootstrap
              ? "Enter the setup token above to configure sign-in."
              : "Only a deployment admin can change this."}
            {config.canClaim && !config.bootstrap && (
              <>
                {" "}
                This deployment has no deployment admin yet: claim the role with the setup token.
              </>
            )}
          </p>
          {config.canClaim && !config.bootstrap && (
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
      )}

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
  // `id`: the deep link /settings#sign-in.
  if (config === null) return <SkeletonCard label={label} hint={hint} rows={3} id="sign-in" />;
  const enabled = config.providers.filter((p) => p.enabled);
  return (
    <SectionCard
      id="sign-in"
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
        Choose how people sign in: Bitbucket Cloud, Gitea / Forgejo, GitHub, GitLab, Google, LDAP /
        Active Directory, OpenID Connect or SAML 2.0. Each provider stays off until configured.
      </p>
    </>
  );
}
