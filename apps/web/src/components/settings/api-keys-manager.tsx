"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { api, type ApiKeyCreated, type ApiKeySummary } from "@/lib/api-client";

const EXPIRY_OPTIONS = [
  { label: "No expiry", days: 0 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
] as const;

function relative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (Math.abs(min) < 60) return `${Math.abs(min)} min ago`;
  const h = Math.round(min / 60);
  if (Math.abs(h) < 48) return `${Math.abs(h)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Personal access tokens for the current user. Tokens are `optio_pat_*` bearer
 * credentials used by the CLI, the iOS app, and scripts; the raw value is shown
 * exactly once after creation.
 */
export function ApiKeysManager() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState<number>(0);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listApiKeys();
      setKeys(res.keys);
      setUnavailable(false);
    } catch {
      // 401 here means there is no real user (OPTIO_AUTH_DISABLED); tokens need a signed-in user.
      setKeys([]);
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setCreating(true);
    try {
      const expiresAt =
        expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000).toISOString() : undefined;
      const res = await api.createApiKey({ name: name.trim() || undefined, expiresAt });
      setCreated(res);
      setCopied(false);
      setName("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      toast.success("Token copied");
    } catch {
      toast.error("Copy failed — select the token and copy it manually");
    }
  }

  async function revoke(key: ApiKeySummary) {
    if (!confirm(`Revoke "${key.name}"? Anything using it will stop working immediately.`)) return;
    setRevoking(key.id);
    try {
      await api.revokeApiKey(key.id);
      if (created?.tokenId === key.id) setCreated(null);
      await load();
      toast.success("Token revoked");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke token");
    } finally {
      setRevoking(null);
    }
  }

  if (keys === null) {
    return (
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
      <p className="text-xs text-text-muted">
        Personal access tokens authenticate the CLI (
        <code className="px-1 rounded bg-bg">optio login</code>
        ), the iOS app, and scripts. Send one as{" "}
        <code className="px-1 rounded bg-bg">Authorization: Bearer optio_pat_…</code>. The value is
        shown once.
      </p>

      {unavailable && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
          Tokens need a signed-in user. With authentication disabled, any bearer value is accepted,
          so clients can use a placeholder such as <code className="px-1 rounded bg-bg">dev</code>.
        </div>
      )}

      {created && (
        <div
          className="p-3 rounded-lg border border-primary/30 bg-primary/5 space-y-2"
          data-testid="api-key-created"
        >
          <p className="text-xs font-medium">
            New token “{created.name}” — copy it now, it won’t be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono break-all px-2 py-1.5 rounded bg-bg border border-border select-all">
              {created.token}
            </code>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-primary text-white hover:bg-primary/90"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="text-[11px] text-text-muted hover:text-text"
          >
            Dismiss
          </button>
        </div>
      )}

      {!unavailable && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name (e.g. iPhone)"
            maxLength={80}
            className="flex-1 min-w-[10rem] px-3 py-1.5 rounded-lg border border-border bg-bg text-sm"
          />
          <select
            value={expiryDays}
            onChange={(e) => setExpiryDays(Number(e.target.value))}
            className="px-2 py-1.5 rounded-lg border border-border bg-bg text-sm"
            aria-label="Expiry"
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={creating}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm bg-primary text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create token
          </button>
        </form>
      )}

      {keys.length === 0 ? (
        !unavailable && (
          <p className="text-xs text-text-muted flex items-center gap-2">
            <KeyRound className="w-3.5 h-3.5" /> No tokens yet.
          </p>
        )
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border">
          {keys.map((k) => {
            const expired = !!k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
            return (
              <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{k.name}</p>
                  <p className="text-[11px] text-text-muted font-mono truncate">
                    {k.prefix}… · created {relative(k.createdAt)} · last used{" "}
                    {relative(k.lastUsedAt)}
                    {k.expiresAt && (
                      <span className={expired ? "text-error" : ""}>
                        {" "}
                        · {expired ? "expired" : "expires"}{" "}
                        {new Date(k.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => revoke(k)}
                  disabled={revoking === k.id}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-error hover:bg-error/10 disabled:opacity-50"
                  aria-label={`Revoke ${k.name}`}
                >
                  {revoking === k.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
