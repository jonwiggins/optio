"use client";

import { useCallback, useEffect, useState } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import {
  Loader2,
  Plus,
  Trash2,
  KeyRound,
  Globe,
  FolderGit2,
  Filter,
  User,
  Info,
} from "lucide-react";
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

  const loadSecrets = () => {
    const scope = scopeFilter === "all" ? undefined : scopeFilter;
    api
      .listSecrets(scope)
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

  useEffect(() => {
    setLoading(true);
    loadSecrets();
  }, [scopeFilter]);

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

  /** Display-friendly label for a scope value */
  const scopeLabel = (scope: string) => {
    if (scope === "global") return "Global";
    if (scope === "user") return "User-only";
    const repo = repos.find((r) => r.repoUrl === scope);
    return repo?.fullName ?? scope;
  };

  const hasUserScopedSecrets = secrets.some((s) => s.scope === "user");

  /** Unique scopes present in the current secrets list (for filter dropdown) */
  const uniqueScopes = Array.from(new Set(secrets.map((s) => s.scope)));

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Secrets</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Secret
        </button>
      </div>

      {claudeExpired && (
        <div className="mb-6">
          <TokenRefreshBanner onSaved={checkClaudeAuth} />
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mb-6 p-5 rounded-xl border border-border/50 bg-bg-card space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-text-muted mb-1">Name</label>
              <input
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="ANTHROPIC_API_KEY"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-sm text-text-muted mb-1">Scope</label>
              <select
                value={form.scope}
                onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              >
                <option value="global">Global (all repos)</option>
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.repoUrl}>
                    {repo.fullName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm text-text-muted mb-1">Value</label>
            <input
              required
              type="password"
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              placeholder="sk-ant-..."
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
            >
              {submitting ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 rounded-md bg-bg-hover text-text-muted text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {hasUserScopedSecrets && (
        <div className="mb-4 p-3 rounded-lg border border-border/50 bg-bg-card flex gap-2 text-xs text-text-muted">
          <Info className="w-4 h-4 shrink-0 text-text-muted mt-0.5" />
          <div>
            <strong className="text-text">User-only</strong> secrets are scoped to a single user and
            are <strong>not visible to background runs</strong> (GitHub ticket sync, scheduled
            triggers, webhooks) since those have no user context. To make a credential available
            everywhere, store it as <strong>Global</strong>.
          </div>
        </div>
      )}

      {/* Scope filter */}
      <div className="flex items-center gap-2 mb-4">
        <Filter className="w-4 h-4 text-text-muted" />
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
        >
          <option value="all">All scopes</option>
          <option value="global">Global only</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.repoUrl}>
              {repo.fullName}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading...
        </div>
      ) : secrets.length === 0 ? (
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <KeyRound className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No secrets configured</p>
          <p className="text-xs mt-1">Add API keys for Claude Code or Codex to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {secrets.map((secret: any) => (
            <div
              key={secret.id}
              className="flex items-center justify-between p-3 rounded-xl border border-border/50 bg-bg-card"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{secret.name}</span>
                <span className="inline-flex items-center gap-1 text-xs text-text-muted px-2 py-0.5 rounded-full bg-bg-hover">
                  {secret.scope === "global" ? (
                    <Globe className="w-3 h-3" />
                  ) : secret.scope === "user" ? (
                    <User className="w-3 h-3" />
                  ) : (
                    <FolderGit2 className="w-3 h-3" />
                  )}
                  {scopeLabel(secret.scope)}
                </span>
              </div>
              <button
                onClick={() => handleDelete(secret.name, secret.scope)}
                className="p-1.5 rounded-md hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                title="Delete secret"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
