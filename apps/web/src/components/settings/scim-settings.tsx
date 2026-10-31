"use client";

import { useEffect, useState } from "react";
import { SIGN_IN_PROVIDERS, SIGN_IN_PROVIDER_LABEL, type SignInProviderName } from "@optio/shared";
import { toast } from "sonner";
import { request, type SignInConfig } from "@/lib/api-client";
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, LABEL, HELP } from "./settings-ui";

interface ScimSettingsView {
  enabled: boolean;
  baseUrl: string;
  signInProvider: SignInProviderName | null;
  tokens: Array<{ id: string; name: string; prefix: string }>;
  deactivationHold?: { heldAt: string | null; releasedUntil: string | null };
}

/** A deployment admin configures the provisioning client and rotates its token. */
export function ScimSettings() {
  const [view, setView] = useState<ScimSettingsView | null>(null);
  const [provider, setProvider] = useState("");
  const [name, setName] = useState("SCIM");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The sign-in providers that are set up (Settings → Sign-in), the only ones
  // whose sign-ins can claim provisioned accounts. Null while unknown (or
  // unreadable): every provider is offered.
  const [configured, setConfigured] = useState<SignInProviderName[] | null>(null);
  useEffect(() => {
    request<SignInConfig>("/api/auth/sign-in")
      .then((c) =>
        setConfigured(
          Array.isArray(c?.providers)
            ? c.providers.filter((p) => p.enabled).map((p) => p.provider)
            : null,
        ),
      )
      .catch(() => setConfigured(null));
  }, []);
  const offered = [...SIGN_IN_PROVIDERS]
    .filter(
      (p) => !configured || configured.includes(p) || p === provider || p === view?.signInProvider,
    )
    .sort((a, b) => SIGN_IN_PROVIDER_LABEL[a].localeCompare(SIGN_IN_PROVIDER_LABEL[b]));
  const load = async () => {
    const v = await request<ScimSettingsView>("/api/admin/scim");
    setView(v);
    setProvider(v.signInProvider ?? "");
  };
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, []);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await load();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="SCIM provisioning" className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">SCIM 2.0 provisioning</h3>
      <p className={HELP}>
        Your identity provider pushes users and groups to Optio. Removing a user or setting active
        to false disables the account, revokes sessions and keys, and pauses their automations. Off
        until you generate a token; revoke every token to turn it off.
      </p>
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      {view && (
        <>
          <p className={HELP}>
            {view.enabled ? "On" : "Off"} · Base URL: <code>{view.baseUrl}</code>
          </p>
          {view.deactivationHold?.releasedUntil ? (
            <p role="status" className={HELP}>
              Deactivations go through until{" "}
              {new Date(view.deactivationHold.releasedUntil).toLocaleTimeString()}.
            </p>
          ) : (
            view.deactivationHold?.heldAt && (
              <div role="alert" className="space-y-2">
                <p className="text-xs text-error">
                  SCIM deactivations are on hold since{" "}
                  {new Date(view.deactivationHold.heldAt).toLocaleString()}: the identity provider
                  asked to deactivate more provisioned accounts, at once or within 15 minutes, than
                  the directory sync&apos;s hold allows. It keeps retrying. Check its assignments,
                  then release the hold to let them through for 15 minutes.
                </p>
                <button
                  className={BTN_SECONDARY}
                  disabled={busy}
                  onClick={() =>
                    void perform(() => request("/api/admin/scim/hold/release", { method: "POST" }))
                  }
                >
                  Release the hold
                </button>
              </div>
            )
          )}
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await request("/api/admin/scim", {
                  method: "PUT",
                  body: JSON.stringify({ signInProvider: provider || null }),
                });
                toast.success("SCIM sign-in provider saved");
              });
            }}
          >
            <label className={LABEL} htmlFor="scim-provider">
              Sign-in provider for provisioned accounts
            </label>
            <select
              id="scim-provider"
              className={INPUT}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="">None — provision accounts only</option>
              {offered.map((p) => (
                <option key={p} value={p}>
                  {SIGN_IN_PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
            <p className={HELP}>
              Choose the same identity provider that provisions these users. Its sign-ins may claim
              provisioned accounts by verified email (or username, for OIDC and LDAP); its group
              rules apply to the SCIM groups. SCIM groups grant deployment admin only when the
              deployment sets OPTIO_SCIM_ALLOW_ADMIN_GROUPS.
            </p>
            <button className={BTN_SECONDARY} disabled={busy} type="submit">
              Save provider
            </button>
          </form>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const r = await request<{ token: string }>("/api/admin/scim/tokens", {
                  method: "POST",
                  body: JSON.stringify({ name }),
                });
                setToken(r.token);
              });
            }}
          >
            <input
              aria-label="SCIM token name"
              className={INPUT}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
            <button className={BTN_PRIMARY} disabled={busy} type="submit">
              Generate token
            </button>
          </form>
          {token && (
            <div role="status" className="space-y-2">
              <p className={HELP}>
                Copy this token into your identity provider. It is shown only once. Whoever holds it
                can disable provisioned accounts, so keep it like an identity-provider admin
                credential.
              </p>
              <input
                aria-label="New SCIM bearer token"
                className={INPUT + " font-mono"}
                readOnly
                value={token}
                onFocus={(e) => e.target.select()}
              />
              <button className={BTN_SECONDARY} onClick={() => setToken(null)}>
                Dismiss token
              </button>
            </div>
          )}
          <ul className="space-y-2">
            {view.tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 text-xs">
                <span>
                  {t.name} · {t.prefix}…
                </span>
                <button
                  className={BTN_SECONDARY}
                  disabled={busy}
                  onClick={() =>
                    void perform(() =>
                      request(`/api/admin/scim/tokens/${t.id}`, { method: "DELETE" }),
                    )
                  }
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
