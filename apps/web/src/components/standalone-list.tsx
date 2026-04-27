"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Bot,
  Clock,
  DollarSign,
  Hand,
  Loader2,
  PlayCircle,
  Search,
  SlidersHorizontal,
  Webhook,
  Workflow,
  X,
} from "lucide-react";
import { toast } from "sonner";

interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  agentRuntime: string;
  model: string | null;
  enabled: boolean;
  runCount: number;
  lastRunAt: string | null;
  createdAt?: string | null;
  totalCostUsd: string | null;
  triggerTypes: string[];
}

const TRIGGER_ICON: Record<string, typeof Clock> = {
  manual: Hand,
  schedule: Clock,
  webhook: Webhook,
};

const TIME_FILTERS = [
  { value: "", label: "All time" },
  { value: "1d", label: "Active 24h" },
  { value: "7d", label: "Active 7d" },
  { value: "30d", label: "Active 30d" },
];

const AGENT_TYPE_OPTIONS = [
  { value: "", label: "All agents" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "copilot", label: "Copilot" },
  { value: "gemini", label: "Gemini" },
  { value: "opencode", label: "OpenCode" },
];

interface FilterState {
  q: string;
  timeFilter: string;
  agentType: string;
  costMin: string;
  costMax: string;
}

const EMPTY_FILTERS: FilterState = {
  q: "",
  timeFilter: "",
  agentType: "",
  costMin: "",
  costMax: "",
};

const FILTER_URL_KEYS: (keyof FilterState)[] = [
  "q",
  "timeFilter",
  "agentType",
  "costMin",
  "costMax",
];

function filtersFromSearchParams(params: URLSearchParams): Partial<FilterState> {
  const partial: Partial<FilterState> = {};
  for (const key of FILTER_URL_KEYS) {
    const val = params.get(key);
    if (val) partial[key] = val;
  }
  return partial;
}

function filtersToSearchParams(filters: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FILTER_URL_KEYS) {
    const val = filters[key];
    if (val && val !== EMPTY_FILTERS[key]) {
      params.set(key, val);
    }
  }
  return params;
}

function cutoffMsFromTimeFilter(timeFilter: string): number | undefined {
  if (!timeFilter) return undefined;
  const now = Date.now();
  switch (timeFilter) {
    case "1d":
      return now - 24 * 60 * 60 * 1000;
    case "7d":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return now - 30 * 24 * 60 * 60 * 1000;
    default:
      return undefined;
  }
}

function formatCost(costStr: string | null) {
  if (!costStr) return null;
  const val = parseFloat(costStr);
  if (isNaN(val) || val === 0) return null;
  return `$${val.toFixed(2)}`;
}

/**
 * Standalone task list — renders workflow definitions using the same card
 * aesthetic as the Repo Tasks list so /tasks feels like one page with two
 * tabs, not two different apps.
 */
export function StandaloneList() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(() => ({
    ...EMPTY_FILTERS,
    ...filtersFromSearchParams(searchParams),
  }));
  const [showAdvanced, setShowAdvanced] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .listWorkflows()
      .then((res) => setItems(res.workflows as WorkflowSummary[]))
      .catch(() => toast.error("Failed to load standalone tasks"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  // Auto-expand advanced filters if any are active from URL
  useEffect(() => {
    const p = filtersFromSearchParams(searchParams);
    if (p.agentType || p.costMin || p.costMax) {
      setShowAdvanced(true);
    }
  }, [searchParams]);

  // Sync filters to URL
  useEffect(() => {
    const params = filtersToSearchParams(filters);
    const newQuery = params.toString();
    const currentQuery = searchParams.toString();
    if (newQuery !== currentQuery) {
      router.replace(`?${newQuery}`, { scroll: false });
    }
  }, [filters, router, searchParams]);

  const updateFilter = useCallback(<K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
  }, []);

  const hasActiveFilters = useMemo(
    () => FILTER_URL_KEYS.some((key) => filters[key] && filters[key] !== EMPTY_FILTERS[key]),
    [filters],
  );

  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const cutoff = cutoffMsFromTimeFilter(filters.timeFilter);
    const costMin = filters.costMin ? parseFloat(filters.costMin) : undefined;
    const costMax = filters.costMax ? parseFloat(filters.costMax) : undefined;

    return items.filter((wf) => {
      if (q) {
        const haystack = `${wf.name} ${wf.description ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (filters.agentType && wf.agentRuntime !== filters.agentType) return false;
      if (cutoff !== undefined) {
        const ref = wf.lastRunAt ?? wf.createdAt;
        if (!ref) return false;
        const t = new Date(ref).getTime();
        if (!Number.isFinite(t) || t < cutoff) return false;
      }
      if (costMin !== undefined && !isNaN(costMin)) {
        const cost = wf.totalCostUsd ? parseFloat(wf.totalCostUsd) : 0;
        if (cost < costMin) return false;
      }
      if (costMax !== undefined && !isNaN(costMax)) {
        const cost = wf.totalCostUsd ? parseFloat(wf.totalCostUsd) : 0;
        if (cost > costMax) return false;
      }
      return true;
    });
  }, [items, filters]);

  const runNow = async (wf: WorkflowSummary) => {
    if (!wf.enabled) {
      toast.error("Task is disabled");
      return;
    }
    setRunningId(wf.id);
    try {
      const res = await api.runWorkflow(wf.id, {});
      toast.success("Run started", { description: `Run ${res.run.id.slice(0, 8)}` });
    } catch (err) {
      toast.error("Failed to start run", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRunningId(null);
    }
  };

  const filterBar = (
    <>
      {/* Search */}
      <div className="mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted/50" />
          <input
            type="text"
            value={filters.q}
            onChange={(e) => updateFilter("q", e.target.value)}
            placeholder="Search standalone tasks by name or description..."
            className="w-full pl-9 pr-9 py-2 bg-transparent border-b border-border/50 text-sm text-text placeholder:text-text-muted/40 focus:outline-none focus:border-text-muted transition-colors"
          />
          {filters.q && (
            <button
              onClick={() => updateFilter("q", "")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted/50 hover:text-text transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-2 mb-4">
        <select
          value={filters.timeFilter}
          onChange={(e) => updateFilter("timeFilter", e.target.value)}
          className="px-2 py-1.5 rounded-lg text-[13px] font-medium bg-transparent border border-border/50 text-text-muted cursor-pointer focus:outline-none focus:border-border hover:border-border transition-colors"
        >
          {TIME_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className={cn(
            "p-1.5 rounded-lg border transition-colors",
            showAdvanced
              ? "bg-bg-card border-border text-text"
              : "border-border/50 text-text-muted hover:border-border hover:text-text",
          )}
          title="Advanced filters"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="text-[11px] text-text-muted hover:text-text transition-colors underline ml-1"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Advanced filters */}
      {showAdvanced && (
        <div className="mb-4 p-3 rounded-lg border border-border/50 bg-bg-card/50">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-[11px] font-medium text-text-muted mb-1">
                Agent Type
              </label>
              <select
                value={filters.agentType}
                onChange={(e) => updateFilter("agentType", e.target.value)}
                className="w-full px-2 py-1.5 rounded-md text-[13px] bg-transparent border border-border/50 text-text cursor-pointer focus:outline-none focus:border-border transition-colors"
              >
                {AGENT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-text-muted mb-1">
                <DollarSign className="w-3 h-3 inline" /> Cost Min
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={filters.costMin}
                onChange={(e) => updateFilter("costMin", e.target.value)}
                placeholder="0.00"
                className="w-full px-2 py-1.5 rounded-md text-[13px] bg-transparent border border-border/50 text-text placeholder:text-text-muted/40 focus:outline-none focus:border-border transition-colors"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-text-muted mb-1">
                <DollarSign className="w-3 h-3 inline" /> Cost Max
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={filters.costMax}
                onChange={(e) => updateFilter("costMax", e.target.value)}
                placeholder="99.99"
                className="w-full px-2 py-1.5 rounded-md text-[13px] bg-transparent border border-border/50 text-text placeholder:text-text-muted/40 focus:outline-none focus:border-border transition-colors"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-text-muted py-10 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading...
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <Workflow className="w-8 h-8 text-text-muted mx-auto mb-3" />
        <p className="text-sm text-text-muted">
          No standalone tasks yet.{" "}
          <Link href="/tasks/new" className="text-primary hover:underline">
            Create one
          </Link>{" "}
          — leave "Attach a repo" off.
        </p>
      </div>
    );
  }

  return (
    <div>
      {filterBar}

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <Workflow className="w-8 h-8 text-text-muted mx-auto mb-3" />
          <p className="text-sm text-text-muted">No standalone tasks match these filters.</p>
          {hasActiveFilters && (
            <button onClick={clearFilters} className="mt-3 text-xs text-primary hover:underline">
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((wf) => (
            <div
              key={wf.id}
              onClick={(e) => {
                // Allow action buttons to stop propagation; otherwise navigate.
                if ((e.target as HTMLElement).closest("[data-stop]")) return;
                window.location.href = `/jobs/${wf.id}`;
              }}
              className={cn(
                "block rounded-md border border-border bg-bg-card cursor-pointer overflow-hidden card-hover",
              )}
            >
              <div className="p-5">
                {/* Top row: title + state + actions */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-sm tracking-tight truncate">{wf.name}</h3>
                      <span className="shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-text-muted/10 text-text-muted">
                        <Bot className="w-3 h-3" />
                        Job
                      </span>
                    </div>
                    {wf.description && (
                      <p className="text-xs text-text-muted mt-1 truncate">{wf.description}</p>
                    )}
                    <div className="flex items-center gap-1.5 mt-2 text-xs text-text-muted">
                      <span className="capitalize">{wf.agentRuntime.replace("-", " ")}</span>
                      {wf.model && (
                        <>
                          <span className="text-text-muted/30 mx-1">&middot;</span>
                          <span>{wf.model}</span>
                        </>
                      )}
                      {wf.triggerTypes.length > 0 && (
                        <>
                          <span className="text-text-muted/30 mx-1">&middot;</span>
                          <div className="flex items-center gap-1">
                            {wf.triggerTypes.map((type) => {
                              const Icon = TRIGGER_ICON[type];
                              if (!Icon) return null;
                              return (
                                <span
                                  key={type}
                                  title={type}
                                  className="inline-flex items-center gap-0.5 text-text-muted/80"
                                >
                                  <Icon className="w-3 h-3" />
                                </span>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {formatCost(wf.totalCostUsd) && (
                      <span className="text-[10px] text-text-muted tabular-nums cost-pill px-2 py-0.5 rounded-full font-medium">
                        {formatCost(wf.totalCostUsd)}
                      </span>
                    )}
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full",
                        wf.enabled
                          ? "bg-success/10 text-success"
                          : "bg-text-muted/10 text-text-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          wf.enabled ? "bg-success" : "bg-text-muted/50",
                        )}
                      />
                      {wf.enabled ? "Active" : "Off"}
                    </span>
                  </div>
                </div>

                {/* Footer: last run + run count + run now button */}
                <div className="flex items-center justify-between mt-4 text-xs text-text-muted/60">
                  <span>
                    {wf.lastRunAt ? `Last run ${formatRelativeTime(wf.lastRunAt)}` : "No runs yet"}
                    <span className="text-text-muted/30 mx-2">&middot;</span>
                    {wf.runCount} run{wf.runCount === 1 ? "" : "s"}
                  </span>
                  <button
                    data-stop
                    onClick={(e) => {
                      e.stopPropagation();
                      runNow(wf);
                    }}
                    disabled={!wf.enabled || runningId === wf.id}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs bg-primary/10 text-primary hover:bg-primary/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed btn-press"
                  >
                    {runningId === wf.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <PlayCircle className="w-3 h-3" />
                    )}
                    Run now
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
