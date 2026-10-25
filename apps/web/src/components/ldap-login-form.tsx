"use client";

import { useId, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import type { PublicSignInProvider } from "@optio/shared";
import { api } from "@/lib/api-client";
import { buttonClass } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

/**
 * The username + password form for an LDAP / Active Directory provider. On
 * success the API answers with a one-time code; the browser then goes to
 * `/auth/callback?code=…`, which exchanges it server-side and sets the
 * session cookie. A refusal (wrong password, not in an allowed group or
 * domain) is shown inline, worded by the API.
 *
 * Shared by the login page and the setup wizard's Sign-in step, where the
 * first sign-in completes the bootstrap.
 */
export function LdapLoginForm({ provider }: { provider: PublicSignInProvider }) {
  const id = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const { code } = await api.ldapLogin({ username: username.trim(), password });
      window.location.href = `/auth/callback?code=${encodeURIComponent(code)}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in");
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      aria-label={`Sign in with ${provider.displayName}`}
      onSubmit={(e) => void submit(e)}
    >
      <div>
        <label
          htmlFor={`${id}-username`}
          className="block text-xs font-medium text-text-muted mb-1.5"
        >
          {provider.usernameLabel?.trim() || "Username"}
        </label>
        <input
          id={`${id}-username`}
          name="username"
          required
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={inputClass()}
        />
      </div>
      <div>
        <label
          htmlFor={`${id}-password`}
          className="block text-xs font-medium text-text-muted mb-1.5"
        >
          Password
        </label>
        <input
          id={`${id}-password`}
          name="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass()}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className={buttonClass({ className: "w-full" })}>
        {busy && <Loader2 className="animate-spin" />}
        Sign in
      </button>
    </form>
  );
}
