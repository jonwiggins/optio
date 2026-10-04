"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { api, type ApiKeyCreated, type ApiKeySummary } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { INPUT, SkeletonCard } from "./settings-ui";

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

  const label = "API keys";
  const hint = "Personal access tokens for the CLI, the apps, and scripts";
  if (keys === null) return <SkeletonCard label={label} hint={hint} rows={1} />;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={
        unavailable
          ? "needs sign-in"
          : keys.length
            ? `${keys.length} token${keys.length === 1 ? "" : "s"}`
            : undefined
      }
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">
        Personal access tokens authenticate the CLI (
        <code className="px-1 rounded bg-bg">optio login</code>
        ), the iOS app, and scripts. Send one as{" "}
        <code className="px-1 rounded bg-bg">Authorization: Bearer optio_pat_…</code>. The value is
        shown once.
      </p>

      {unavailable && (
        <div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-warning text-xs">
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
            <Button type="button" size="sm" onClick={copy} className="shrink-0">
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>
            Dismiss
          </Button>
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
            className={`${INPUT} flex-1 min-w-[10rem] w-auto`}
          />
          <select
            value={expiryDays}
            onChange={(e) => setExpiryDays(Number(e.target.value))}
            className={inputClass({ className: "w-auto" })}
            aria-label="Expiry"
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={creating}>
            {creating ? <Loader2 className="animate-spin" /> : <Plus />}
            Create token
          </Button>
        </form>
      )}

      {keys.length === 0 ? (
        !unavailable && (
          <EmptyState
            size="panel"
            icon={KeyRound}
            title="No tokens yet"
            description="Create one above, then run optio login with it."
          />
        )
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border bg-bg">
          {keys.map((k) => {
            const expired = !!k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
            return (
              <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke(k)}
                  disabled={revoking === k.id}
                  className="shrink-0 hover:text-error hover:bg-error/10"
                  aria-label={`Revoke ${k.name}`}
                >
                  {revoking === k.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
