"use client";
import { useState } from "react";
import { toast } from "sonner";
import { FlaskConical, Loader2 } from "lucide-react";
import type {
  LdapSignInSettings,
  PublicSignInProvider,
  SignInProviderTestResult,
} from "@optio/shared";
import { api, type SignInProviderView } from "@/lib/api-client";
import { Disclosure } from "@/components/ui/disclosure";
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, HELP } from "./settings-ui";
import {
  DEFAULT_DISPLAY_NAME,
  accessDraftOf,
  accessSettingsOf,
  parseDomains,
  opt,
  orNull,
  errorMessage,
  Labeled,
  Checkbox,
  AccessSection,
  TestResultView,
  RemoveButton,
  CaFields,
  displayNameDraft,
  type AccessDraft,
  type ProviderFormProps,
} from "./oidc-sign-in-form";
const DEFAULT_USER_FILTER = "(|(sAMAccountName={{username}})(uid={{username}})(mail={{username}}))";
const DEFAULT_GROUP_FILTER = "(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))";
/** The API's own refusal (OPTIO_LDAP_REQUIRE_TLS), shown before a save is tried. */
const LDAP_TLS_REQUIRED =
  "This deployment requires TLS for LDAP: use an ldaps:// URL or turn on STARTTLS.";
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
  trustEmail: boolean;
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
    trustEmail: s.trustEmail ?? false,
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
    trustEmail: d.trustEmail,
    ...accessSettingsOf(d.access),
  };
}

export function LdapForm({
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

  const requireTls = !!config.ldapRequireTls;
  const plainRefused = requireTls && /^ldap:\/\//i.test(d.url.trim()) && !d.startTls;

  const checkRequired = (): boolean => {
    if (!d.url.trim() || !d.userBaseDn.trim()) {
      toast.error("The server URL and user base DN are required");
      return false;
    }
    if (plainRefused) {
      toast.error(LDAP_TLS_REQUIRED);
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
            requireTls ? (
              <>
                This deployment requires TLS: <code className="font-mono">ldaps://</code>, or{" "}
                <code className="font-mono">ldap://</code> with STARTTLS.
              </>
            ) : (
              <>
                <code className="font-mono">ldaps://</code> for TLS, or{" "}
                <code className="font-mono">ldap://</code> with STARTTLS. Plain{" "}
                <code className="font-mono">ldap://</code> sends passwords in the clear.
              </>
            )
          }
        >
          <input
            required
            value={d.url}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder="ldaps://ad.example.com:636"
            className={INPUT + " font-mono"}
            spellCheck={false}
            aria-invalid={plainRefused || undefined}
          />
        </Labeled>
        {plainRefused && (
          <p role="alert" className="sm:col-span-2 text-xs text-error">
            {LDAP_TLS_REQUIRED}
          </p>
        )}
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
            <div className="sm:col-span-2">
              <Checkbox
                checked={d.trustEmail}
                onChange={(trustEmail) => patch({ trustEmail })}
                label="Trust the directory's email addresses"
                help="Treat the directory's email addresses as verified — only when people can't change their own there. Then a listed OPTIO_DEPLOYMENT_ADMINS address, joining workspaces by email domain and (with Keep existing accounts) linking accounts count it. Off: the address still decides the allowed domains here, but grants nothing by email."
              />
            </div>
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
