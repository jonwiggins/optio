"use client";

import { useEffect, useState, useCallback } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Plus,
  Loader2,
  Trash2,
  X,
  FileText,
  Github,
  MessageSquare,
  BarChart3,
  Database,
  Bug,
  FolderOpen,
  Terminal,
  Globe,
  Briefcase,
  Cloud,
  BookOpen,
  Wrench,
  Plug,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Zap,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  notion: FileText,
  github: Github,
  slack: MessageSquare,
  linear: BarChart3,
  database: Database,
  sentry: Bug,
  folder: FolderOpen,
  terminal: Terminal,
  globe: Globe,
};

const CATEGORIES = [
  { id: "productivity", label: "Productivity", icon: Briefcase },
  { id: "database", label: "Databases", icon: Database },
  { id: "cloud", label: "Cloud", icon: Cloud },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "custom", label: "Custom", icon: Wrench },
];

const AGENT_TYPES = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "gemini", label: "Google Gemini" },
  { value: "opencode", label: "OpenCode" },
  { value: "cursor", label: "Cursor" },
];

const PERMISSION_LEVELS = [
  { value: "read", label: "Read only" },
  { value: "readwrite", label: "Read & Write" },
  { value: "full", label: "Full access" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProviderIcon(icon?: string): React.ComponentType<{ className?: string }> {
  if (icon && PROVIDER_ICONS[icon]) return PROVIDER_ICONS[icon];
  return Plug;
}

function statusColor(status: string | undefined): string {
  if (status === "healthy" || status === "connected") return "bg-green-500";
  if (status === "error" || status === "failed") return "bg-red-500";
  return "bg-gray-400";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ConnectionsPage() {
  usePageTitle("Connections");

  // Data
  const [providers, setProviders] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [repos, setRepos] = useState<any[]>([]);

  // UI
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<any | null>(null);
  const [activeCategoryFilter, setActiveCategoryFilter] = useState<string | null>(null);
  const [showAccessControl, setShowAccessControl] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [formSelectedRepos, setFormSelectedRepos] = useState<string[]>([]);
  const [formSelectedAgents, setFormSelectedAgents] = useState<string[]>([]);
  const [formPermission, setFormPermission] = useState("read");
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [secretVisible, setSecretVisible] = useState<Record<string, boolean>>({});

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const loadData = useCallback(() => {
    Promise.all([
      api.listConnectionProviders().catch(() => ({ providers: [] })),
      api.listConnections().catch(() => ({ connections: [] })),
      api.listRepos().catch(() => ({ repos: [] })),
    ])
      .then(([provRes, connRes, repoRes]) => {
        setProviders(provRes.providers);
        setConnections(connRes.connections);
        setRepos(repoRes.repos);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const resetForm = () => {
    setFormName("");
    setFormConfig({});
    setFormSelectedRepos([]);
    setFormSelectedAgents([]);
    setFormPermission("read");
    setSecretVisible({});
    setShowAccessControl(false);
  };

  const openForm = (provider: any) => {
    setSelectedProvider(provider);
    resetForm();
    setFormName(provider.name ? `My ${provider.name}` : "");
    if (provider.configSchema?.properties) {
      const init: Record<string, string> = {};
      for (const key of Object.keys(provider.configSchema.properties)) {
        init[key] = "";
      }
      setFormConfig(init);
    }
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setSelectedProvider(null);
    resetForm();
  };

  const handleCreate = async () => {
    if (!selectedProvider) return;
    if (!formName.trim()) {
      toast.error("Connection name is required");
      return;
    }
    setSubmitting(true);
    try {
      await api.createConnection({
        providerId: selectedProvider.id,
        name: formName.trim(),
        config: formConfig,
        assignments: [
          {
            repoId: null,
            agentTypes: formSelectedAgents.length > 0 ? formSelectedAgents : [],
            permission: formPermission,
          },
        ],
      });
      toast.success(`${formName.trim()} created`);
      closeForm();
      loadData();
    } catch (err) {
      toast.error("Failed to create connection", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (conn: any) => {
    try {
      await api.updateConnection(conn.id, { enabled: !conn.enabled });
      toast.success(conn.enabled ? "Connection disabled" : "Connection enabled");
      loadData();
    } catch {
      toast.error("Failed to update connection");
    }
  };

  const handleDelete = async (conn: any) => {
    if (!confirm(`Delete connection "${conn.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteConnection(conn.id);
      toast.success("Connection deleted");
      loadData();
    } catch {
      toast.error("Failed to delete connection");
    }
  };

  const handleTest = async (connId: string) => {
    setTesting(connId);
    try {
      const res = await api.testConnection(connId);
      if (res.status === "healthy" || res.status === "connected") {
        toast.success("Connection is healthy", { description: res.message });
      } else {
        toast.error("Connection test failed", { description: res.message });
      }
      loadData();
    } catch (err) {
      toast.error("Test failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setTesting(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const groupedProviders = CATEGORIES.map((cat) => ({
    ...cat,
    providers: providers.filter((p) => p.category === cat.id),
  })).filter((g) => g.providers.length > 0);

  const filteredGroups = activeCategoryFilter
    ? groupedProviders.filter((g) => g.id === activeCategoryFilter)
    : groupedProviders;

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-center py-20 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading connections...
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const configProps = selectedProvider?.configSchema?.properties as Record<string, any> | undefined;
  const configRequired: string[] = selectedProvider?.configSchema?.required ?? [];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-text">Connections</h1>
            <p className="text-sm text-text-muted mt-1">
              Connect external services and tools to your agents
            </p>
          </div>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-2 bg-primary text-white hover:bg-primary/90 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Connection
            </button>
          )}
        </div>

        {/* ── Inline add form ──────────────────────────────────────────── */}
        {showForm && (
          <section className="space-y-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
            {/* Provider selector (compact grid) */}
            {!selectedProvider && (
              <>
                <label className="block text-xs text-text-muted mb-1">Choose a provider</label>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {providers.map((p) => {
                    const Ic = getProviderIcon(p.icon);
                    return (
                      <button
                        key={p.id}
                        onClick={() => openForm(p)}
                        className="flex items-center gap-2 p-2 rounded-lg border border-border bg-bg hover:border-primary/40 hover:bg-bg-hover text-left text-xs transition-colors"
                      >
                        <Ic className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                        <span className="truncate">{p.name}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={closeForm}
                    className="px-3 py-1.5 rounded-md text-xs text-text-muted hover:bg-bg-hover"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {/* Form fields (shown once provider is picked) */}
            {selectedProvider && (
              <>
                {/* Provider badge + change link */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {(() => {
                      const Ic = getProviderIcon(selectedProvider.icon);
                      return <Ic className="w-4 h-4 text-primary" />;
                    })()}
                    <span className="text-xs font-medium text-text">{selectedProvider.name}</span>
                    {selectedProvider.description && (
                      <span className="text-xs text-text-muted hidden sm:inline">
                        — {selectedProvider.description}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setSelectedProvider(null);
                      resetForm();
                    }}
                    className="text-xs text-primary hover:underline"
                  >
                    Change
                  </button>
                </div>

                {/* Name + first config field (2-col grid) */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-text-muted mb-1">
                      Connection name <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="e.g. Production Notion"
                      className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                    />
                  </div>
                  {/* Render first config field inline if there's exactly 1 or 2 */}
                  {configProps &&
                    Object.entries(configProps)
                      .slice(0, 1)
                      .map(([key, schema]) => {
                        const isSecret = schema.format === "secret";
                        const visible = secretVisible[key] ?? false;
                        return (
                          <div key={key}>
                            <label className="block text-xs text-text-muted mb-1">
                              {schema.title ?? key}
                              {configRequired.includes(key) && (
                                <span className="text-red-400 ml-0.5">*</span>
                              )}
                            </label>
                            <div className="relative">
                              <input
                                type={isSecret && !visible ? "password" : "text"}
                                value={formConfig[key] ?? ""}
                                onChange={(e) =>
                                  setFormConfig((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                placeholder={schema.placeholder ?? ""}
                                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 pr-9"
                                autoComplete={isSecret ? "new-password" : "off"}
                              />
                              {isSecret && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSecretVisible((prev) => ({ ...prev, [key]: !prev[key] }))
                                  }
                                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
                                  tabIndex={-1}
                                >
                                  {visible ? (
                                    <EyeOff className="w-3.5 h-3.5" />
                                  ) : (
                                    <Eye className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                </div>

                {/* Remaining config fields (full width, if more than 1 field) */}
                {configProps &&
                  Object.entries(configProps)
                    .slice(1)
                    .map(([key, schema]) => {
                      const isSecret = schema.format === "secret";
                      const visible = secretVisible[key] ?? false;
                      return (
                        <div key={key}>
                          <label className="block text-xs text-text-muted mb-1">
                            {schema.title ?? key}
                            {configRequired.includes(key) && (
                              <span className="text-red-400 ml-0.5">*</span>
                            )}
                          </label>
                          <div className="relative">
                            <input
                              type={isSecret && !visible ? "password" : "text"}
                              value={formConfig[key] ?? ""}
                              onChange={(e) =>
                                setFormConfig((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              placeholder={schema.placeholder ?? ""}
                              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 pr-9"
                              autoComplete={isSecret ? "new-password" : "off"}
                            />
                            {isSecret && (
                              <button
                                type="button"
                                onClick={() =>
                                  setSecretVisible((prev) => ({ ...prev, [key]: !prev[key] }))
                                }
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
                                tabIndex={-1}
                              >
                                {visible ? (
                                  <EyeOff className="w-3.5 h-3.5" />
                                ) : (
                                  <Eye className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}

                {/* Collapsible access control */}
                <button
                  type="button"
                  onClick={() => setShowAccessControl(!showAccessControl)}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text transition-colors"
                >
                  {showAccessControl ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                  Access control
                  <span className="text-text-muted/50 ml-1">
                    (All repos · All agents ·{" "}
                    {PERMISSION_LEVELS.find((p) => p.value === formPermission)?.label ??
                      "Read only"}
                    )
                  </span>
                </button>

                {showAccessControl && (
                  <div className="space-y-3 pl-4 border-l-2 border-border/50">
                    {/* Permission */}
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Permission</label>
                      <div className="relative">
                        <select
                          value={formPermission}
                          onChange={(e) => setFormPermission(e.target.value)}
                          className="w-full appearance-none px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 pr-8"
                        >
                          {PERMISSION_LEVELS.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
                      </div>
                    </div>

                    {/* Agents */}
                    <div>
                      <label className="block text-xs text-text-muted mb-1">
                        Limit to specific agents{" "}
                        <span className="text-text-muted/50">(leave empty for all)</span>
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {AGENT_TYPES.map((agent) => (
                          <button
                            key={agent.value}
                            type="button"
                            onClick={() =>
                              setFormSelectedAgents((prev) =>
                                prev.includes(agent.value)
                                  ? prev.filter((v) => v !== agent.value)
                                  : [...prev, agent.value],
                              )
                            }
                            className={cn(
                              "px-2.5 py-1 rounded-md text-xs border transition-colors",
                              formSelectedAgents.includes(agent.value)
                                ? "border-primary/50 bg-primary/10 text-primary"
                                : "border-border text-text-muted hover:bg-bg-hover",
                            )}
                          >
                            {agent.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Repos */}
                    {repos.length > 0 && (
                      <div>
                        <label className="block text-xs text-text-muted mb-1">
                          Limit to specific repos{" "}
                          <span className="text-text-muted/50">(leave empty for all)</span>
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {repos.map((repo) => (
                            <button
                              key={repo.id}
                              type="button"
                              onClick={() =>
                                setFormSelectedRepos((prev) =>
                                  prev.includes(repo.id)
                                    ? prev.filter((id) => id !== repo.id)
                                    : [...prev, repo.id],
                                )
                              }
                              className={cn(
                                "px-2.5 py-1 rounded-md text-xs border transition-colors truncate max-w-48",
                                formSelectedRepos.includes(repo.id)
                                  ? "border-primary/50 bg-primary/10 text-primary"
                                  : "border-border text-text-muted hover:bg-bg-hover",
                              )}
                            >
                              {repo.fullName ?? repo.repoUrl}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeForm}
                    className="px-3 py-1.5 rounded-md text-xs text-text-muted hover:bg-bg-hover"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={submitting}
                    className="px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
                    {submitting ? "Saving..." : "Add Connection"}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {/* ── Active Connections ────────────────────────────────────────── */}
        {connections.length > 0 && (
          <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              Active Connections ({connections.length})
            </h2>
            <div className="space-y-2">
              {connections.map((conn) => {
                const provider = providers.find((p) => p.id === conn.providerId);
                const IconComp = getProviderIcon(provider?.icon);
                return (
                  <div
                    key={conn.id}
                    className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg"
                  >
                    <span
                      className={cn("w-2 h-2 rounded-full flex-shrink-0", statusColor(conn.status))}
                    />
                    <IconComp className="w-4 h-4 text-text-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text truncate">{conn.name}</span>
                        {provider && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted">
                            {provider.name}
                          </span>
                        )}
                        {!conn.enabled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted">
                            disabled
                          </span>
                        )}
                      </div>
                      {conn.lastCheckedAt && (
                        <span className="text-[11px] text-text-muted/60">
                          Checked {formatRelativeTime(conn.lastCheckedAt)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => handleTest(conn.id)}
                        disabled={testing === conn.id}
                        className="px-2 py-1 text-xs border border-border text-text-muted hover:bg-bg-hover rounded-md transition-colors disabled:opacity-50"
                        title="Test connection"
                      >
                        {testing === conn.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Zap className="w-3 h-3" />
                        )}
                      </button>
                      <button
                        onClick={() => handleToggle(conn)}
                        className={cn(
                          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                          conn.enabled ? "bg-primary" : "bg-gray-500/30",
                        )}
                        title={conn.enabled ? "Disable" : "Enable"}
                      >
                        <span
                          className={cn(
                            "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                            conn.enabled ? "translate-x-4.5" : "translate-x-1",
                          )}
                        />
                      </button>
                      <button
                        onClick={() => handleDelete(conn)}
                        className="p-1 rounded-md hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Provider Catalog ─────────────────────────────────────────── */}
        <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              Available Providers
            </h2>
          </div>

          {/* Category filter tabs */}
          {groupedProviders.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setActiveCategoryFilter(null)}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  activeCategoryFilter === null
                    ? "bg-primary text-white"
                    : "border border-border text-text-muted hover:bg-bg-hover",
                )}
              >
                All
              </button>
              {CATEGORIES.map((cat) => {
                const hasProviders = providers.some((p) => p.category === cat.id);
                if (!hasProviders) return null;
                const CatIcon = cat.icon;
                return (
                  <button
                    key={cat.id}
                    onClick={() =>
                      setActiveCategoryFilter(activeCategoryFilter === cat.id ? null : cat.id)
                    }
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                      activeCategoryFilter === cat.id
                        ? "bg-primary text-white"
                        : "border border-border text-text-muted hover:bg-bg-hover",
                    )}
                  >
                    <CatIcon className="w-3 h-3" />
                    {cat.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Empty state */}
          {filteredGroups.length === 0 && providers.length === 0 && (
            <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
              <Plug className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No providers available</p>
              <p className="text-xs mt-1">Connection providers will appear here once configured.</p>
            </div>
          )}

          {/* Provider grid by category */}
          {filteredGroups.map((group) => {
            const CatIcon = group.icon;
            return (
              <div key={group.id}>
                <div className="flex items-center gap-2 mb-2">
                  <CatIcon className="w-3.5 h-3.5 text-text-muted" />
                  <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    {group.label}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-4">
                  {group.providers.map((provider) => {
                    const IconComp = getProviderIcon(provider.icon);
                    return (
                      <button
                        key={provider.id}
                        onClick={() => openForm(provider)}
                        className="flex items-center gap-3 p-3 border border-border rounded-lg bg-bg hover:border-primary/40 hover:bg-bg-hover transition-colors text-left group"
                      >
                        <div className="p-1.5 rounded-md bg-bg-hover border border-border/50 group-hover:border-primary/30 transition-colors">
                          <IconComp className="w-4 h-4 text-text-muted group-hover:text-primary transition-colors" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-text">{provider.name}</p>
                          <p className="text-[11px] text-text-muted mt-0.5 line-clamp-1">
                            {provider.description ?? "Connect to " + provider.name}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
