"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useStore, type TaskSummary } from "@/hooks/use-store";
import { TaskCard } from "./task-card";
import {
  Loader2,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Search,
  X,
  Bookmark,
  SlidersHorizontal,
  DollarSign,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

// ---------------------------------------------------------------------------
// Pipeline stage derivation — mirrors the logic in pipeline-timeline.tsx
// so the task list sections match the individual task detail view.
// ---------------------------------------------------------------------------

type PipelineStage =
  | "queue"
  | "setup"
  | "running"
  | "ci"
  | "review"
  | "done"
  | "failed"
  | "attention";

function getTaskStage(
  t: TaskSummary,
  subs: { hasRunning: boolean; hasQueued: boolean; hasAny: boolean; allDone: boolean },
): PipelineStage {
  if (["completed", "cancelled"].includes(t.state)) return "done";
  if (t.state === "failed") return "failed";
  if (["pending", "queued"].includes(t.state)) return "queue";
  if (t.state === "provisioning") return "setup";
  if (t.state === "running") return "running";
  if (t.state === "needs_attention") return "attention";

  // pr_opened — determine which post-PR pipeline stage
  if (t.state === "pr_opened") {
    if (subs.hasRunning) return "review";
    if (subs.hasQueued) return "review";
    if (t.prReviewStatus && !["none", "pending"].includes(t.prReviewStatus)) return "review";
    const checks = t.prChecksStatus;
    if (!checks || ["none", "pending"].includes(checks)) return "ci";
    if (checks === "failing") return "ci";
    if (checks === "passing") return "review";
    return "ci";
  }

  return "queue";
}

// ---------------------------------------------------------------------------
// Filter definitions
// ---------------------------------------------------------------------------

const STAGE_FILTERS = [
  { value: "", label: "All" },
  { value: "queue", label: "Queue" },
  { value: "running", label: "Running" },
  { value: "ci", label: "CI" },
  { value: "review", label: "Review" },
  { value: "attention", label: "Attention" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

const TIME_FILTERS = [
  { value: "1d", label: "Active 24h" },
  { value: "7d", label: "Active 7d" },
  { value: "30d", label: "Active 30d" },
  { value: "", label: "All time" },
];

const AGENT_TYPE_OPTIONS = [
  { value: "", label: "All agents" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "copilot", label: "Copilot" },
  { value: "opencode", label: "OpenCode" },
  { value: "cursor", label: "Cursor" },
];

function getDateFromTimeFilter(timeFilter: string): string | undefined {
  if (!timeFilter) return undefined;
  const now = new Date();
  switch (timeFilter) {
    case "1d":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Saved views — persisted in localStorage
// ---------------------------------------------------------------------------

interface SavedView {
  id: string;
  name: string;
  filters: FilterState;
}

interface FilterState {
  q: string;
  stage: string;
  timeFilter: string;
  repoUrl: string;
  agentType: string;
  costMin: string;
  costMax: string;
}

const EMPTY_FILTERS: FilterState = {
  q: "",
  stage: "",
  timeFilter: "1d",
  repoUrl: "",
  agentType: "",
  costMin: "",
  costMax: "",
};

const SAVED_VIEWS_KEY = "optio-saved-views";

function loadSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistSavedViews(views: SavedView[]) {
  localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
}

// ---------------------------------------------------------------------------
// URL <-> filter sync helpers
// ---------------------------------------------------------------------------

const FILTER_URL_KEYS: (keyof FilterState)[] = [
  "q",
  "stage",
  "timeFilter",
  "repoUrl",
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TaskList() {
  const tasks = useStore(useShallow((state) => state.tasks));
  const setTasks = useStore((state) => state.setTasks);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Initialize filters from URL
  const [filters, setFilters] = useState<FilterState>(() => ({
    ...EMPTY_FILTERS,
    ...filtersFromSearchParams(searchParams),
  }));

  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [repos, setRepos] = useState<{ id: string; repoUrl: string; fullName: string }[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load saved views and repos on mount
  useEffect(() => {
    setSavedViews(loadSavedViews());
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
  }, []);

  // Auto-expand advanced filters if any are active from URL
  useEffect(() => {
    const p = filtersFromSearchParams(searchParams);
    if (p.repoUrl || p.agentType || p.costMin || p.costMax) {
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

  // Fetch tasks using search API
  const fetchTasks = useCallback((filtersToUse: FilterState, cursor?: string) => {
    const createdAfter = getDateFromTimeFilter(filtersToUse.timeFilter);
    return api.searchTasks({
      q: filtersToUse.q || undefined,
      repoUrl: filtersToUse.repoUrl || undefined,
      agentType: filtersToUse.agentType || undefined,
      costMin: filtersToUse.costMin || undefined,
      costMax: filtersToUse.costMax || undefined,
      createdAfter,
      cursor,
      limit: 200,
    });
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchTasks(filters)
      .then((res) => {
        setTasks(res.tasks);
        setNextCursor(res.nextCursor);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filters, fetchTasks, setTasks]);

  // Debounced refresh when filters change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      refresh();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refresh]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    fetchTasks(filters, nextCursor)
      .then((res) => {
        setTasks([...tasks, ...res.tasks]);
        setNextCursor(res.nextCursor);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [nextCursor, loadingMore, filters, fetchTasks, tasks, setTasks]);

  // Filter updaters
  const updateFilter = useCallback(<K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
  }, []);

  const hasActiveFilters = useMemo(
    () =>
      filters.q !== "" ||
      filters.repoUrl !== "" ||
      filters.agentType !== "" ||
      filters.costMin !== "" ||
      filters.costMax !== "" ||
      filters.timeFilter !== "1d",
    [filters],
  );

  // Saved views management
  const handleSaveView = useCallback(() => {
    if (!saveViewName.trim()) return;
    const newView: SavedView = {
      id: crypto.randomUUID(),
      name: saveViewName.trim(),
      filters: { ...filters },
    };
    const updated = [...savedViews, newView];
    setSavedViews(updated);
    persistSavedViews(updated);
    setSaveViewName("");
    setShowSaveDialog(false);
    toast.success(`View "${newView.name}" saved`);
  }, [saveViewName, filters, savedViews]);

  const handleLoadView = useCallback((view: SavedView) => {
    setFilters(view.filters);
    if (
      view.filters.repoUrl ||
      view.filters.agentType ||
      view.filters.costMin ||
      view.filters.costMax
    ) {
      setShowAdvanced(true);
    }
  }, []);

  const handleDeleteView = useCallback(
    (id: string) => {
      const updated = savedViews.filter((v) => v.id !== id);
      setSavedViews(updated);
      persistSavedViews(updated);
    },
    [savedViews],
  );

  // Memoize parent->subtask map
  const { reviewMap, topLevelAll } = useMemo(() => {
    const map = new Map<string, TaskSummary[]>();
    const topLevel: TaskSummary[] = [];

    for (const t of tasks) {
      if (t.parentTaskId) {
        const existing = map.get(t.parentTaskId) ?? [];
        existing.push(t);
        map.set(t.parentTaskId, existing);
      } else {
        topLevel.push(t);
      }
    }

    return { reviewMap: map, topLevelAll: topLevel };
  }, [tasks]);

  // Memoize stage derivation
  const taskStages = useMemo(() => {
    const stages = new Map<string, PipelineStage>();
    for (const t of topLevelAll) {
      const subs = reviewMap.get(t.id) ?? [];
      const status = {
        hasRunning: subs.some((s) => ["running", "provisioning"].includes(s.state)),
        hasQueued: subs.some((s) => ["queued", "pending"].includes(s.state)),
        hasAny: subs.length > 0,
        allDone:
          subs.length > 0 &&
          subs.every((s) => ["completed", "failed", "cancelled"].includes(s.state)),
      };
      stages.set(t.id, getTaskStage(t, status));
    }
    return stages;
  }, [topLevelAll, reviewMap]);

  // Memoize filtered + sectioned data
  const { attention, running, ci, review, queued, failed, completed, visibleTasks, stageCounts } =
    useMemo(() => {
      // Apply stage filter (client-side — stages depend on subtask status)
      const visible = filters.stage
        ? topLevelAll.filter((t) => taskStages.get(t.id) === filters.stage)
        : topLevelAll;

      // Split into sections by stage
      const sections = {
        attention: visible.filter((t) => taskStages.get(t.id) === "attention"),
        running: visible.filter((t) => {
          const s = taskStages.get(t.id);
          return s === "running" || s === "setup";
        }),
        ci: visible.filter((t) => taskStages.get(t.id) === "ci"),
        review: visible.filter((t) => taskStages.get(t.id) === "review"),
        queued: visible.filter((t) => taskStages.get(t.id) === "queue"),
        failed: visible.filter((t) => taskStages.get(t.id) === "failed"),
        completed: visible.filter((t) => taskStages.get(t.id) === "done"),
      };

      // Compute counts per stage for filter badges
      const counts = new Map<string, number>();
      for (const t of topLevelAll) {
        const stage = taskStages.get(t.id)!;
        counts.set(stage, (counts.get(stage) ?? 0) + 1);
      }

      return { ...sections, visibleTasks: visible, stageCounts: counts };
    }, [topLevelAll, taskStages, filters.stage]);

  const moveTask = async (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= queued.length) return;

    const reordered = [...queued];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(newIndex, 0, moved);

    const newTasks = [
      ...attention,
      ...running,
      ...ci,
      ...review,
      ...reordered,
      ...failed,
      ...completed,
    ];
    setTasks(newTasks);

    try {
      await api.reorderTasks(reordered.map((t) => t.id));
    } catch {
      toast.error("Failed to reorder");
      refresh();
    }
  };

  return (
    <div>
      {/* Search */}
      <div className="mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted/50" />
          <input
            type="text"
            value={filters.q}
            onChange={(e) => updateFilter("q", e.target.value)}
            placeholder="Search tasks by title or prompt..."
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
      <div className="flex flex-col gap-2 mb-4">
        <div className="flex gap-1.5 flex-wrap">
          {STAGE_FILTERS.map((f) => {
            const count = f.value ? (stageCounts.get(f.value) ?? 0) : topLevelAll.length;
            return (
              <button
                key={f.value}
                onClick={() => updateFilter("stage", f.value)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors flex items-center gap-1.5",
                  filters.stage === f.value
                    ? "bg-bg-card border border-border text-text"
                    : "text-text-muted hover:bg-bg-hover hover:text-text",
                )}
              >
                {f.label}
                {f.value && count > 0 && (
                  <span className="text-[11px] text-text-muted/40">{count}</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 self-start">
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
        </div>
      </div>

      {/* Advanced filters */}
      {showAdvanced && (
        <div className="mb-4 p-3 rounded-lg border border-border/50 bg-bg-card/50 space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* Repo filter */}
            <div>
              <label className="block text-[11px] font-medium text-text-muted mb-1">
                Repository
              </label>
              <select
                value={filters.repoUrl}
                onChange={(e) => updateFilter("repoUrl", e.target.value)}
                className="w-full px-2 py-1.5 rounded-md text-[13px] bg-transparent border border-border/50 text-text cursor-pointer focus:outline-none focus:border-border transition-colors"
              >
                <option value="">All repos</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.repoUrl}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </div>

            {/* Agent type filter */}
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

            {/* Cost range */}
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

          {/* Active filter tags + actions */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 flex-wrap">
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="text-[11px] text-text-muted hover:text-text transition-colors underline"
                >
                  Clear all filters
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Saved views dropdown */}
              {savedViews.length > 0 && (
                <div className="relative group">
                  <button className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text transition-colors">
                    <Bookmark className="w-3 h-3" />
                    Saved Views ({savedViews.length})
                  </button>
                  <div className="absolute right-0 top-full mt-1 w-48 bg-bg-card border border-border rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                    {savedViews.map((view) => (
                      <div
                        key={view.id}
                        className="flex items-center justify-between px-3 py-2 hover:bg-bg-hover first:rounded-t-lg last:rounded-b-lg"
                      >
                        <button
                          onClick={() => handleLoadView(view)}
                          className="text-[12px] text-text truncate flex-1 text-left"
                        >
                          {view.name}
                        </button>
                        <button
                          onClick={() => handleDeleteView(view.id)}
                          className="text-text-muted/50 hover:text-error ml-2 shrink-0 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Save current view */}
              {showSaveDialog ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={saveViewName}
                    onChange={(e) => setSaveViewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveView();
                      if (e.key === "Escape") setShowSaveDialog(false);
                    }}
                    placeholder="View name"
                    className="px-2 py-1 text-[11px] bg-transparent border border-border rounded-md text-text placeholder:text-text-muted/40 focus:outline-none w-28"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveView}
                    className="text-[11px] text-primary hover:text-primary-hover transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setShowSaveDialog(false)}
                    className="text-[11px] text-text-muted hover:text-text transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowSaveDialog(true)}
                  className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text transition-colors"
                >
                  <Bookmark className="w-3 h-3" />
                  Save View
                </button>
              )}
            </div>
          </div>

          {/* Loaded count */}
          {!loading && (
            <div className="text-[11px] text-text-muted/50">
              {topLevelAll.length} task{topLevelAll.length !== 1 ? "s" : ""} loaded
              {nextCursor ? " (more available)" : ""}
            </div>
          )}
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading tasks...
        </div>
      ) : visibleTasks.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <p>No tasks found</p>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="mt-2 text-sm text-primary hover:text-primary-hover transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-8">
          {attention.length > 0 && (
            <Section label="Needs Your Input" count={attention.length}>
              {attention.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}

          {running.length > 0 && (
            <Section label="Running" count={running.length}>
              {running.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}

          {ci.length > 0 && (
            <Section label="CI Checks" count={ci.length}>
              {ci.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}

          {review.length > 0 && (
            <Section label="Review" count={review.length}>
              {review.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}

          {queued.length > 0 && (
            <Section label="Queue" count={queued.length}>
              {queued.length > 1 && (
                <div className="text-xs text-text-muted/50 mb-2 flex items-center gap-1.5">
                  <GripVertical className="w-3 h-3" />
                  Use arrows to reprioritize
                </div>
              )}
              {queued.map((task, i) => (
                <div key={task.id} className="flex items-center gap-1.5">
                  {queued.length > 1 && (
                    <div className="flex flex-col shrink-0 rounded-md bg-bg-card p-0.5">
                      <button
                        onClick={() => moveTask(i, "up")}
                        disabled={i === 0}
                        className="p-0.5 text-text-muted hover:text-text disabled:opacity-20 transition-colors"
                      >
                        <ChevronUp className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => moveTask(i, "down")}
                        disabled={i === queued.length - 1}
                        className="p-0.5 text-text-muted hover:text-text disabled:opacity-20 transition-colors"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <TaskCard task={task} subtasks={reviewMap.get(task.id)} />
                  </div>
                </div>
              ))}
            </Section>
          )}

          {failed.length > 0 && (
            <Section
              label="Failed"
              count={failed.length}
              collapsible
              initialLimit={filters.stage ? undefined : 5}
            >
              {failed.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}

          {completed.length > 0 && (
            <Section
              label="Done"
              count={completed.length}
              collapsible
              initialLimit={filters.stage ? undefined : 5}
            >
              {completed.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}

          {/* Load more */}
          {nextCursor && (
            <div className="flex justify-center pt-2">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-bg-card border border-border text-text-muted hover:text-text hover:bg-bg-hover disabled:opacity-50 transition-colors"
              >
                {loadingMore && <Loader2 className="w-3 h-3 animate-spin" />}
                Load more tasks
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section component with optional collapse
// ---------------------------------------------------------------------------

function Section({
  label,
  count,
  children,
  collapsible,
  initialLimit,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  collapsible?: boolean;
  initialLimit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const childArray = React.Children.toArray(children);
  const shouldLimit = collapsible && initialLimit != null && childArray.length > initialLimit;
  const visibleChildren = shouldLimit && !expanded ? childArray.slice(0, initialLimit) : childArray;

  return (
    <div>
      <div
        className={cn("flex items-center gap-2 mb-3", collapsible && "cursor-pointer select-none")}
        onClick={collapsible ? () => setExpanded((e) => !e) : undefined}
      >
        {collapsible && (
          <ChevronRight
            className={cn(
              "w-3.5 h-3.5 text-text-muted/50 transition-transform",
              expanded && "rotate-90",
            )}
          />
        )}
        <span className="text-xs font-medium uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <span className="text-xs text-text-muted/40">{count}</span>
      </div>
      <div className="grid gap-2.5">
        {visibleChildren}
        {shouldLimit && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-text-muted hover:text-text py-2 transition-colors"
          >
            Show all {childArray.length}
          </button>
        )}
      </div>
    </div>
  );
}
