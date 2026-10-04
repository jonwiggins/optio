"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { useCurrentUser } from "@/hooks/use-current-user";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Plus, Trash2, KeyRound, FolderGit2, Info } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { SectionCard } from "@/components/ui/section-card";
import { OwnerPicker } from "@/components/ui/owner-picker";
import { OwnerSegments, useOwnerFilter } from "@/components/ui/owner-segments";
import { ScopedList } from "@/components/ui/scoped-list";
import { OwnerChip } from "@/components/ui/owner-chip";
import { TokenRefreshBanner } from "@/components/token-refresh-banner";
import { countByOwner, ownerScope, privateHint, type OwnerScope } from "@/lib/owner";

interface SecretRow {
  id: string;
  name: string;
  scope: string;
  userId?: string | null;
  ownerUserId?: string | null;
  ownerName?: string | null;
}

/**
 * Secrets, grouped by scope: the organization's (instance-wide and per repo),
 * the viewer's private ones, and — for an admin — other people's private
 * ones by name. The "+ New" form opens on the scope the viewer is looking at.
 */
export default function SecretsPage() {
  usePageTitle("Secrets");
  return (
    <Suspense fallback={<div className="p-6 max-w-4xl mx-auto h-32 skeleton-shimmer rounded-lg" />}>
      <SecretsList />
    </Suspense>
  );
}

function SecretsList() {
  const { userId, isAdmin } = useCurrentUser();
  const [owner, setOwner] = useOwnerFilter();
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", value: "", scope: "global" });
  const [submitting, setSubmitting] = useState(false);
  const [claudeExpired, setClaudeExpired] = useState(false);

  const checkClaudeAuth = useCallback(async () => {
    try {
      const res = await api.getAuthStatus();
      setClaudeExpired(res.subscription.expired === true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    checkClaudeAuth();
    const onChanged = () => checkClaudeAuth();
    const onFailed = () => setClaudeExpired(true);
    window.addEventListener("optio:auth-status-changed", onChanged);
    window.addEventListener("optio:auth-failed", onFailed);
    return () => {
      window.removeEventListener("optio:auth-status-changed", onChanged);
      window.removeEventListener("optio:auth-failed", onFailed);
    };
  }, [checkClaudeAuth]);

  // One fetch of everything the viewer may see; the segments filter it
  // client-side so each can show a count.
  const loadSecrets = () => {
    api
      .listSecrets()
      .then((res) => setSecrets(res.secrets))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
    loadSecrets();
  }, []);

  /** The scope the form opens on: the segment being viewed, else what the viewer may make. */
  const openForm = (scope?: OwnerScope) => {
    const wanted = scope ?? (owner === "organization" || owner === "private" ? owner : null);
    const privateFirst = wanted ? wanted === "private" : !isAdmin;
    setForm((f) => ({ ...f, scope: privateFirst ? "user" : "global" }));
    setShowForm(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createSecret(form);
      toast.success("Secret saved", { description: `${form.name} has been encrypted and stored.` });
      setForm({ name: "", value: "", scope: "global" });
      setShowForm(false);
      loadSecrets();
    } catch (err) {
      toast.error("Failed to save secret", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (secret: SecretRow) => {
    try {
      // Someone else's private secret (an admin, offboarding) names its owner.
      const other = ownerScope(secret, userId) === "others" ? secret.ownerUserId : undefined;
      await api.deleteSecret(secret.name, secret.scope, other ?? undefined);
      toast.success("Secret deleted");
      loadSecrets();
    } catch {
      toast.error("Failed to delete secret");
    }
  };

  const repoName = (scope: string) =>
    repos.find((r) => r.repoUrl === scope)?.fullName ?? scope.replace(/^https?:\/\//, "");

  const counts = countByOwner(secrets, userId);
  const formScope = form.scope === "user" ? "private" : "organization";

  const inputClass =
    "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20";

  const newButton = (scope?: OwnerScope, small = false) => (
    <button
      type="button"
      onClick={() => openForm(scope)}
      className={
        small
          ? "text-primary hover:underline"
          : "flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
      }
    >
      {small ? "+ New" : <Plus className="w-4 h-4" />}
      {!small && "Add secret"}
    </button>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        icon={KeyRound}
        title="Secrets"
        description="Encrypted at rest and injected into agent pods. Values are never shown again."
        meta={
          secrets.length > 0 ? (
            <span>
              {secrets.length} secret{secrets.length === 1 ? "" : "s"} · {counts.organization}{" "}
              organization · {counts.private} private
              {counts.others > 0 && ` · ${counts.others} other people's`}
            </span>
          ) : null
        }
        actions={newButton()}
      />

      {claudeExpired && (
        <div className="mb-6">
          <TokenRefreshBanner onSaved={checkClaudeAuth} />
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6">
          <SectionCard
            label="New secret"
            hint="Encrypted with AES-256-GCM before it's stored"
            bodyClassName="p-4 space-y-3"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-muted mb-1">Name</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="ANTHROPIC_API_KEY"
                  className={inputClass + " font-mono"}
                />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Value</label>
                <input
                  required
                  type="password"
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  placeholder="sk-ant-..."
                  className={inputClass}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-3">
              <OwnerPicker
                what="secret"
                value={formScope}
                canOrg={isAdmin}
                onChange={(v) =>
                  setForm((f) => ({ ...f, scope: v === "private" ? "user" : "global" }))
                }
                privateHint="Only your own work gets it. Background runs of the organization's work (schedules, webhooks, ticket sync) don't."
                orgHint="Every run in the workspace can use it."
              />
              {formScope === "organization" && (
                <div className="flex-1 min-w-[12rem]">
                  <label className="block text-xs text-text-muted mb-1">Repos</label>
                  <select
                    value={form.scope}
                    onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
                    className={inputClass}
                  >
                    <option value="global">All repos</option>
                    {repos.map((repo) => (
                      <option key={repo.id} value={repo.repoUrl}>
                        {repo.fullName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover disabled:opacity-50"
              >
                {submitting ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 rounded-md border border-border text-text-muted text-sm hover:text-text hover:bg-bg-hover"
              >
                Cancel
              </button>
            </div>
          </SectionCard>
        </form>
      )}

      {counts.private > 0 && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-border/70 bg-bg-card/40 flex gap-2 text-xs text-text-muted">
          <Info className="w-4 h-4 shrink-0 text-text-muted mt-0.5" />
          <div>
            <strong className="text-text">Private</strong> secrets are yours alone: only your work
            gets them, so the organization's background runs (ticket sync, schedules, webhooks){" "}
            <strong>don't see them</strong>. Store a credential for the{" "}
            <strong>Organization</strong> to make it available everywhere.
          </div>
        </div>
      )}

      {secrets.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <OwnerSegments rows={secrets} viewerId={userId} value={owner} onChange={setOwner} />
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-12 skeleton-shimmer rounded-lg" />
          ))}
        </div>
      ) : secrets.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No secrets configured"
          description="Add API keys for Claude Code or Codex, and tokens for your git host."
          action={!showForm && newButton()}
        />
      ) : (
        <ScopedList
          rows={secrets}
          filter={owner}
          viewerId={userId}
          privateEmpty={privateHint("secrets")}
          sectionActions={(scope) => (scope === "others" ? null : newButton(scope, true))}
          render={(rows, scope) =>
            rows.length === 0 ? (
              <p className="px-4 py-4 text-xs text-text-muted">No secrets in this scope.</p>
            ) : (
              rows.map((secret) => {
                const isRepo = secret.scope !== "global" && secret.scope !== "user";
                return (
                  <div
                    key={secret.id}
                    className="group flex items-center gap-3 px-4 py-3 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
                  >
                    <KeyRound className="w-3.5 h-3.5 text-text-muted shrink-0" />
                    <span className="text-sm font-medium font-mono text-text-heading truncate min-w-0 flex-1">
                      {secret.name}
                    </span>
                    <div className="flex items-center gap-3 text-[11px] text-text-muted shrink-0">
                      {isRepo && (
                        <span className="inline-flex items-center gap-1">
                          <FolderGit2 className="w-3 h-3" />
                          {repoName(secret.scope)}
                        </span>
                      )}
                      {/* Sections already say the scope; the chip is for a flat (filtered) list. */}
                      {scope === null && <OwnerChip row={secret} viewerId={userId} />}
                      {scope === "others" && (
                        <span className="text-text-muted">{secret.ownerName ?? "someone"}</span>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(secret)}
                      className="p-1.5 rounded-md hover:bg-error/10 text-text-muted hover:text-error opacity-60 group-hover:opacity-100 focus:opacity-100 transition-all"
                      title={
                        ownerScope(secret, userId) === "others"
                          ? `Delete ${secret.ownerName ?? "their"}'s private secret`
                          : "Delete secret"
                      }
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )
          }
        />
      )}
    </div>
  );
}
