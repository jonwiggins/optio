"use client";

import { useCallback, useEffect, useState } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Plus, Trash2, KeyRound, Building2, FolderGit2, User, Info } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { TokenRefreshBanner } from "@/components/token-refresh-banner";

export default function SecretsPage() {
  usePageTitle("Secrets");
  const [secrets, setSecrets] = useState<any[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", value: "", scope: "global" });
  const [submitting, setSubmitting] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<string>("all");
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

  // One fetch of everything the caller can see (workspace secrets plus their
  // own); the scope pills filter it client-side so each can show a count.
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

  const handleDelete = async (name: string, scope: string) => {
    try {
      await api.deleteSecret(name, scope);
      toast.success("Secret deleted");
      loadSecrets();
    } catch (err) {
      toast.error("Failed to delete secret");
    }
  };

  const repoName = (scope: string) =>
    repos.find((r) => r.repoUrl === scope)?.fullName ?? scope.replace(/^https?:\/\//, "");

  const hasUserScopedSecrets = secrets.some((s) => s.scope === "user");

  // Pills: All / Organization / Mine, then one per repo that has secrets
  // (a select instead when there are many of those).
  const repoScopes = Array.from(
    new Set(secrets.map((s) => s.scope).filter((sc) => sc !== "global" && sc !== "user")),
  );
  const countFor = (f: string) =>
    f === "all" ? secrets.length : secrets.filter((s) => s.scope === f).length;
  const scopeOptions = [
    { value: "all", label: "All", count: countFor("all") },
    { value: "global", label: "Organization", count: countFor("global") },
    { value: "user", label: "Mine", count: countFor("user") },
    ...(repoScopes.length <= 3
      ? repoScopes.map((sc) => ({ value: sc, label: repoName(sc), count: countFor(sc) }))
      : []),
  ];
  const visible = secrets.filter((s) => scopeFilter === "all" || s.scope === scopeFilter);

  const inputClass =
    "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20";

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        icon={KeyRound}
        title="Secrets"
        description="Encrypted at rest and injected into agent pods. Values are never shown again."
        meta={
          secrets.length > 0 ? (
            <span>
              {secrets.length} secret{secrets.length === 1 ? "" : "s"} · {countFor("global")}{" "}
              organization · {countFor("user")} yours
            </span>
          ) : null
        }
        actions={
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Secret
          </button>
        }
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
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <span className="block text-xs text-text-muted mb-1">Owner</span>
                <Segmented
                  aria-label="Owner"
                  value={form.scope === "user" ? "user" : "org"}
                  onChange={(v) =>
                    setForm((f) => ({ ...f, scope: v === "user" ? "user" : "global" }))
                  }
                  options={[
                    {
                      value: "org",
                      label: "Organization",
                      icon: <Building2 className="w-3 h-3" />,
                    },
                    { value: "user", label: "Just me", icon: <User className="w-3 h-3" /> },
                  ]}
                />
              </div>
              {form.scope !== "user" && (
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
            <p className="text-[11px] text-text-muted">
              {form.scope === "user"
                ? "Only your own runs see it — background runs (schedules, webhooks, ticket sync) don't."
                : "Every run in the workspace can use it. Saving organization secrets needs an admin."}
            </p>
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

      {hasUserScopedSecrets && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-border/70 bg-bg-card/40 flex gap-2 text-xs text-text-muted">
          <Info className="w-4 h-4 shrink-0 text-text-muted mt-0.5" />
          <div>
            <strong className="text-text">Just me</strong> secrets are scoped to a single user and
            are <strong>not visible to background runs</strong> (GitHub ticket sync, scheduled
            triggers, webhooks) since those have no user context. To make a credential available
            everywhere, store it for the <strong>Organization</strong>.
          </div>
        </div>
      )}

      {secrets.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Segmented
            size="md"
            surface="card"
            wrap
            className="gap-1"
            aria-label="Filter by scope"
            value={scopeOptions.some((o) => o.value === scopeFilter) ? scopeFilter : "all"}
            onChange={setScopeFilter}
            options={scopeOptions}
          />
          {repoScopes.length > 3 && (
            <select
              aria-label="Filter by repo"
              value={repoScopes.includes(scopeFilter) ? scopeFilter : ""}
              onChange={(e) => setScopeFilter(e.target.value || "all")}
              className="px-3 py-1.5 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
            >
              <option value="">Any repo…</option>
              {repoScopes.map((sc) => (
                <option key={sc} value={sc}>
                  {repoName(sc)}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-12 skeleton-shimmer rounded-lg" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={secrets.length === 0 ? "No secrets configured" : "No secrets in this scope"}
          description="Add API keys for Claude Code or Codex, and tokens for your git host."
          action={
            !showForm && (
              <button
                onClick={() => setShowForm(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover"
              >
                <Plus className="w-4 h-4" /> Add Secret
              </button>
            )
          }
        />
      ) : (
        <div className="rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60">
          {visible.map((secret: any) => {
            const owner = secret.scope === "user" ? "Just me" : "Organization";
            const OwnerIcon = secret.scope === "user" ? User : Building2;
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
                  <span
                    className={
                      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded " +
                      (secret.scope === "user"
                        ? "bg-primary/10 text-primary"
                        : "bg-bg-hover text-text-muted")
                    }
                  >
                    <OwnerIcon className="w-3 h-3" />
                    {owner}
                  </span>
                </div>
                <button
                  onClick={() => handleDelete(secret.name, secret.scope)}
                  className="p-1.5 rounded-md hover:bg-error/10 text-text-muted hover:text-error opacity-60 group-hover:opacity-100 focus:opacity-100 transition-all"
                  title="Delete secret"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
