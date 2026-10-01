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
  Database,
  FolderOpen,
  Terminal,
  Globe,
  Briefcase,
  Cloud,
  BookOpen,
  Wrench,
  Plug,
  Building2,
  ChevronDown,
  ChevronRight,
  User,
  Eye,
  EyeOff,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { Panel } from "@/components/ui/panel";
import { brandFor, brandIconComponent } from "@/components/brand-icon";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Generic marks; branded providers (GitHub, Slack, Linear, Notion, Sentry) use BrandIcon. */
const PROVIDER_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  database: Database,
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
  const brand = brandFor(icon);
  if (brand) return brandIconComponent(brand);
  if (icon && PROVIDER_ICONS[icon]) return PROVIDER_ICONS[icon];
  return Plug;
}

function statusColor(status: string | undefined): string {
  if (status === "healthy" || status === "connected") return "bg-success";
  if (status === "error" || status === "failed") return "bg-error";
  return "bg-text-muted/40";
}

/** The one small chip style on this page (provider, owner, disabled). */
function Chip({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "primary";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0",
        tone === "primary" ? "bg-primary/10 text-primary" : "bg-bg-hover text-text-muted",
      )}
    >
      {children}
    </span>
  );
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
  // Organization (admins) or Just me (only injected into work you own).
  const [formOwner, setFormOwner] = useState<"workspace" | "me">("workspace");
  const [isAdmin, setIsAdmin] = useState(true);
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
    api
      .getCurrentUser()
      .then((r) => {
        // Auth disabled (no workspace role) behaves as an admin, like the API.
        const admin = !r.user.workspaceRole || r.user.workspaceRole === "admin";
        setIsAdmin(admin);
        if (!admin) setFormOwner("me");
      })
      .catch(() => {});
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
    setFormOwner(isAdmin ? "workspace" : "me");
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
        owner: formOwner,
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
        <div className="h-16 skeleton-shimmer rounded-lg mb-6" />
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-14 skeleton-shimmer rounded-lg" />
          ))}
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
      <div className="space-y-6 [&>header]:mb-0">
        <PageHeader
          icon={Plug}
          title="Connections"
          description="External services and tools, injected into your agents' pods over MCP."
          meta={
            connections.length > 0 ? (
              <span>
                {connections.length} connection{connections.length === 1 ? "" : "s"} ·{" "}
                {connections.filter((c) => c.enabled).length} enabled · {providers.length} providers
              </span>
            ) : null
          }
          actions={
            !showForm && (
              <button
                onClick={() => setShowForm(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Connection
              </button>
            )
          }
        />

        {/* ── Inline add form ──────────────────────────────────────────── */}
        {showForm && (
          <SectionCard
            label="New connection"
            hint={selectedProvider ? undefined : "Choose a provider"}
            summary={selectedProvider?.name}
            bodyClassName="p-4 space-y-3"
          >
            {/* Provider selector (compact grid) */}
            {!selectedProvider && (
              <>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {providers.map((p) => {
                    const Ic = getProviderIcon(p.icon);
                    return (
                      <button
                        key={p.id}
                        onClick={() => openForm(p)}
                        className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border bg-bg hover:border-primary/40 hover:bg-bg-hover text-left text-xs transition-colors"
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

                {/* Owner */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-text-muted">Owner</span>
                  <Segmented
                    aria-label="Owner"
                    value={formOwner}
                    onChange={setFormOwner}
                    options={[
                      {
                        value: "workspace",
                        label: "Organization",
                        icon: <Building2 className="w-3 h-3" />,
                        disabled: isAdmin ? undefined : "Only admins add organization connections",
                      },
                      { value: "me", label: "Just me", icon: <User className="w-3 h-3" /> },
                    ]}
                  />
                  <span className="text-[11px] text-text-muted">
                    {formOwner === "me"
                      ? "Only work that runs as you gets it."
                      : "Available to the organization's work."}
                  </span>
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
                      <Segmented
                        aria-label="Permission"
                        value={formPermission}
                        onChange={setFormPermission}
                        options={PERMISSION_LEVELS}
                      />
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
          </SectionCard>
        )}

        {/* ── Active Connections ────────────────────────────────────────── */}
        {connections.length > 0 && (
          <Panel
            title="Active connections"
            actions={<span className="text-text-muted tabular-nums">{connections.length}</span>}
          >
            <div className="divide-y divide-border/60">
              {connections.map((conn) => {
                const provider = providers.find((p) => p.id === conn.providerId);
                const IconComp = getProviderIcon(provider?.icon);
                return (
                  <div
                    key={conn.id}
                    className="group flex items-center gap-3 px-4 py-3 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
                  >
                    <span
                      className={cn("w-2 h-2 rounded-full flex-shrink-0", statusColor(conn.status))}
                    />
                    <IconComp className="w-4 h-4 text-text-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-heading truncate">
                          {conn.name}
                        </span>
                        {provider && <Chip>{provider.name}</Chip>}
                        {conn.ownerUserId && (
                          <Chip tone="primary">
                            <User className="w-2.5 h-2.5" />
                            Just me
                          </Chip>
                        )}
                        {!conn.enabled && <Chip>disabled</Chip>}
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
                        className="p-1.5 text-text-muted hover:text-text hover:bg-bg-hover rounded-md transition-colors disabled:opacity-50"
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
                          conn.enabled ? "bg-primary" : "bg-border",
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
                        className="p-1.5 rounded-md hover:bg-error/10 text-text-muted hover:text-error opacity-60 group-hover:opacity-100 focus:opacity-100 transition-all"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        )}

        {/* ── Provider Catalog ─────────────────────────────────────────── */}
        <Panel title="Available providers">
          <div className="p-4 space-y-4">
            {/* Category filter */}
            {groupedProviders.length > 1 && (
              <Segmented
                wrap
                aria-label="Filter by category"
                value={activeCategoryFilter ?? "all"}
                onChange={(v) => setActiveCategoryFilter(v === "all" ? null : v)}
                options={[
                  { value: "all", label: "All", count: providers.length },
                  ...groupedProviders.map((g) => {
                    const CatIcon = g.icon;
                    return {
                      value: g.id,
                      label: g.label,
                      icon: <CatIcon className="w-3 h-3" />,
                      count: g.providers.length,
                    };
                  }),
                ]}
              />
            )}

            {/* Empty state */}
            {filteredGroups.length === 0 && providers.length === 0 && (
              <EmptyState
                size="panel"
                icon={Plug}
                title="No providers available"
                description="Connection providers will appear here once configured."
              />
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
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
          </div>
        </Panel>
      </div>
    </div>
  );
}
