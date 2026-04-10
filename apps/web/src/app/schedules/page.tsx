"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import { NumberInput } from "@/components/number-input";
import { toast } from "sonner";
import {
  Loader2,
  Plus,
  Trash2,
  Clock,
  Play,
  Pause,
  RotateCw,
  ChevronDown,
  ChevronUp,
  Zap,
  History,
} from "lucide-react";

interface Schedule {
  id: string;
  name: string;
  description: string | null;
  cronExpression: string;
  enabled: boolean;
  taskConfig: {
    title: string;
    prompt: string;
    repoUrl: string;
    repoBranch?: string;
    agentType: string;
    maxRetries?: number;
    priority?: number;
  };
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRun {
  id: string;
  scheduleId: string;
  taskId: string | null;
  status: string;
  error: string | null;
  triggeredAt: string;
}

const CRON_PRESETS = [
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at midnight", value: "0 0 * * *" },
  { label: "Every day at 9am", value: "0 9 * * *" },
  { label: "Every Monday at midnight", value: "0 0 * * 1" },
  { label: "Every weekday at 9am", value: "0 9 * * 1-5" },
  { label: "First of every month", value: "0 0 1 * *" },
];

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [repos, setRepos] = useState<{ id: string; repoUrl: string; fullName: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ScheduleRun[]>>({});
  const [runsLoading, setRunsLoading] = useState<string | null>(null);
  const [cronPreview, setCronPreview] = useState<{
    valid: boolean;
    description?: string;
    nextRun?: string;
    error?: string;
  } | null>(null);
  const [cronValidating, setCronValidating] = useState(false);

  interface ScheduleForm {
    name: string;
    description: string;
    cronExpression: string;
    enabled: boolean;
    taskConfig: {
      title: string;
      prompt: string;
      repoUrl: string;
      repoBranch: string;
      agentType: string;
      maxRetries: number;
      priority: number;
    };
  }

  const emptyForm: ScheduleForm = {
    name: "",
    description: "",
    cronExpression: "0 0 * * *",
    enabled: true,
    taskConfig: {
      title: "",
      prompt: "",
      repoUrl: "",
      repoBranch: "",
      agentType: "claude-code",
      maxRetries: 3,
      priority: 100,
    },
  };
  const [form, setForm] = useState<ScheduleForm>(emptyForm);

  const loadSchedules = useCallback(() => {
    api
      .listSchedules()
      .then((res) => setSchedules(res.schedules as Schedule[]))
      .catch(() => toast.error("Failed to load schedules"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadSchedules();
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
  }, [loadSchedules]);

  const validateCron = useCallback(async (expression: string) => {
    if (!expression.trim()) {
      setCronPreview(null);
      return;
    }
    setCronValidating(true);
    try {
      const result = await api.validateCron(expression);
      setCronPreview(result);
    } catch {
      setCronPreview({ valid: false, error: "Failed to validate" });
    } finally {
      setCronValidating(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (form.cronExpression) validateCron(form.cronExpression);
    }, 500);
    return () => clearTimeout(timer);
  }, [form.cronExpression, validateCron]);

  const loadRuns = async (scheduleId: string) => {
    if (expandedId === scheduleId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(scheduleId);
    setRunsLoading(scheduleId);
    try {
      const res = await api.getScheduleRuns(scheduleId, 20);
      setRuns((prev) => ({ ...prev, [scheduleId]: res.runs as ScheduleRun[] }));
    } catch {
      toast.error("Failed to load run history");
    } finally {
      setRunsLoading(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        name: form.name,
        description: form.description || undefined,
        cronExpression: form.cronExpression,
        enabled: form.enabled,
        taskConfig: {
          title: form.taskConfig.title,
          prompt: form.taskConfig.prompt,
          repoUrl: form.taskConfig.repoUrl,
          agentType: form.taskConfig.agentType,
          ...(form.taskConfig.repoBranch ? { repoBranch: form.taskConfig.repoBranch } : {}),
          maxRetries: form.taskConfig.maxRetries,
          priority: form.taskConfig.priority,
        },
      };

      if (editingId) {
        await api.updateSchedule(editingId, payload);
        toast.success("Schedule updated");
      } else {
        await api.createSchedule(payload);
        toast.success("Schedule created");
      }
      setForm(emptyForm);
      setShowForm(false);
      setEditingId(null);
      loadSchedules();
    } catch (err) {
      toast.error(editingId ? "Failed to update schedule" : "Failed to create schedule", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = (schedule: Schedule) => {
    setForm({
      name: schedule.name,
      description: schedule.description ?? "",
      cronExpression: schedule.cronExpression,
      enabled: schedule.enabled,
      taskConfig: {
        title: schedule.taskConfig.title,
        prompt: schedule.taskConfig.prompt,
        repoUrl: schedule.taskConfig.repoUrl,
        repoBranch: schedule.taskConfig.repoBranch ?? "",
        agentType: schedule.taskConfig.agentType,
        maxRetries: schedule.taskConfig.maxRetries ?? 3,
        priority: schedule.taskConfig.priority ?? 100,
      },
    });
    setEditingId(schedule.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteSchedule(id);
      toast.success("Schedule deleted");
      loadSchedules();
    } catch {
      toast.error("Failed to delete schedule");
    }
  };

  const handleToggle = async (schedule: Schedule) => {
    try {
      await api.updateSchedule(schedule.id, { enabled: !schedule.enabled });
      toast.success(schedule.enabled ? "Schedule paused" : "Schedule enabled");
      loadSchedules();
    } catch {
      toast.error("Failed to update schedule");
    }
  };

  const handleTrigger = async (id: string) => {
    try {
      await api.triggerSchedule(id);
      toast.success("Schedule triggered — task created");
      loadSchedules();
    } catch (err) {
      toast.error("Failed to trigger schedule", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleString();
  };

  const repoLabel = (url: string) => {
    const repo = repos.find((r) => r.repoUrl === url);
    return repo?.fullName ?? url;
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Schedules</h1>
        <button
          onClick={() => {
            if (showForm && !editingId) {
              setShowForm(false);
            } else {
              setForm(emptyForm);
              setEditingId(null);
              setShowForm(true);
            }
          }}
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Schedule
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mb-6 p-5 rounded-xl border border-border/50 bg-bg-card space-y-4"
        >
          <h2 className="text-lg font-medium">{editingId ? "Edit Schedule" : "Create Schedule"}</h2>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-text-muted mb-1">Schedule Name</label>
              <input
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="nightly-tests"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-sm text-text-muted mb-1">Description</label>
              <input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Run tests every night at midnight"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>

          {/* Cron expression */}
          <div>
            <label className="block text-sm text-text-muted mb-1">Cron Expression</label>
            <div className="flex gap-2">
              <input
                required
                value={form.cronExpression}
                onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
                placeholder="0 0 * * *"
                className="flex-1 px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) setForm((f) => ({ ...f, cronExpression: e.target.value }));
                }}
                className="px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              >
                <option value="">Presets...</option>
                {CRON_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            {cronValidating && <p className="text-xs text-text-muted mt-1">Validating...</p>}
            {cronPreview && !cronValidating && (
              <p className={`text-xs mt-1 ${cronPreview.valid ? "text-text-muted" : "text-error"}`}>
                {cronPreview.valid
                  ? `${cronPreview.description} — Next run: ${formatDate(cronPreview.nextRun ?? null)}`
                  : cronPreview.error}
              </p>
            )}
          </div>

          {/* Task config */}
          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-medium text-text-muted mb-3">Task Configuration</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-text-muted mb-1">Task Title</label>
                <input
                  required
                  value={form.taskConfig.title}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      taskConfig: { ...f.taskConfig, title: e.target.value },
                    }))
                  }
                  placeholder="Run nightly test suite"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm text-text-muted mb-1">Repository</label>
                <select
                  required
                  value={form.taskConfig.repoUrl}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      taskConfig: { ...f.taskConfig, repoUrl: e.target.value },
                    }))
                  }
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                >
                  <option value="">Select repository...</option>
                  {repos.map((repo) => (
                    <option key={repo.id} value={repo.repoUrl}>
                      {repo.fullName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3">
              <label className="block text-sm text-text-muted mb-1">Prompt</label>
              <textarea
                required
                value={form.taskConfig.prompt}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    taskConfig: { ...f.taskConfig, prompt: e.target.value },
                  }))
                }
                placeholder="Run the full test suite and fix any failing tests..."
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>

            <div className="grid grid-cols-4 gap-3 mt-3">
              <div>
                <label className="block text-sm text-text-muted mb-1">Agent</label>
                <select
                  value={form.taskConfig.agentType}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      taskConfig: {
                        ...f.taskConfig,
                        agentType: e.target.value,
                      },
                    }))
                  }
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                >
                  <option value="claude-code">Claude Code</option>
                  <option value="codex">Codex</option>
                  <option value="copilot">Copilot</option>
                  <option value="opencode">OpenCode (Experimental)</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="openclaw">OpenClaw (Experimental)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-text-muted mb-1">Branch</label>
                <input
                  value={form.taskConfig.repoBranch}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      taskConfig: { ...f.taskConfig, repoBranch: e.target.value },
                    }))
                  }
                  placeholder="main"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-sm text-text-muted mb-1">Max Retries</label>
                <NumberInput
                  min={0}
                  max={10}
                  value={form.taskConfig.maxRetries}
                  onChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      taskConfig: { ...f.taskConfig, maxRetries: v },
                    }))
                  }
                  fallback={0}
                />
              </div>
              <div>
                <label className="block text-sm text-text-muted mb-1">Priority</label>
                <NumberInput
                  min={1}
                  max={1000}
                  value={form.taskConfig.priority}
                  onChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      taskConfig: { ...f.taskConfig, priority: v },
                    }))
                  }
                  fallback={100}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                className="rounded"
              />
              Enabled
            </label>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
            >
              {submitting ? "Saving..." : editingId ? "Update Schedule" : "Create Schedule"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
                setForm(emptyForm);
              }}
              className="px-4 py-2 rounded-md bg-bg-hover text-text-muted text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading...
        </div>
      ) : schedules.length === 0 ? (
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No schedules configured</p>
          <p className="text-xs mt-1">
            Create a schedule to run tasks automatically on a cron schedule.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => (
            <div
              key={schedule.id}
              className="rounded-xl border border-border/50 bg-bg-card overflow-hidden"
            >
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${schedule.enabled ? "bg-green-500" : "bg-zinc-400"}`}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{schedule.name}</span>
                      <code className="text-xs text-text-muted bg-bg-hover px-1.5 py-0.5 rounded font-mono">
                        {schedule.cronExpression}
                      </code>
                    </div>
                    {schedule.description && (
                      <p className="text-xs text-text-muted truncate mt-0.5">
                        {schedule.description}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
                      <span>{repoLabel(schedule.taskConfig.repoUrl)}</span>
                      <span>Last: {formatDate(schedule.lastRunAt)}</span>
                      <span>Next: {formatDate(schedule.nextRunAt)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleTrigger(schedule.id)}
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-primary transition-colors"
                    title="Trigger now"
                  >
                    <Zap className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleToggle(schedule)}
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
                    title={schedule.enabled ? "Pause" : "Enable"}
                  >
                    {schedule.enabled ? (
                      <Pause className="w-4 h-4" />
                    ) : (
                      <Play className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => loadRuns(schedule.id)}
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
                    title="Run history"
                  >
                    <History className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleEdit(schedule)}
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
                    title="Edit"
                  >
                    <RotateCw className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(schedule.id)}
                    className="p-1.5 rounded-md hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setExpandedId(expandedId === schedule.id ? null : schedule.id)}
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
                  >
                    {expandedId === schedule.id ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              {/* Expanded: run history */}
              {expandedId === schedule.id && (
                <div className="border-t border-border/50 px-4 py-3 bg-bg/50">
                  <h4 className="text-xs font-medium text-text-muted mb-2">Run History</h4>
                  {runsLoading === schedule.id ? (
                    <div className="flex items-center gap-2 text-xs text-text-muted py-2">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Loading...
                    </div>
                  ) : !runs[schedule.id] || runs[schedule.id].length === 0 ? (
                    <p className="text-xs text-text-muted py-2">No runs yet</p>
                  ) : (
                    <div className="space-y-1.5">
                      {runs[schedule.id].map((run) => (
                        <div
                          key={run.id}
                          className="flex items-center justify-between text-xs py-1.5 px-2 rounded-lg bg-bg"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                run.status === "created"
                                  ? "bg-green-500"
                                  : run.status === "failed"
                                    ? "bg-red-500"
                                    : "bg-yellow-500"
                              }`}
                            />
                            <span className="text-text-muted">{formatDate(run.triggeredAt)}</span>
                            <span className="capitalize">{run.status}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {run.taskId && (
                              <a
                                href={`/tasks/${run.taskId}`}
                                className="text-primary hover:underline"
                              >
                                View task
                              </a>
                            )}
                            {run.error && (
                              <span className="text-error truncate max-w-[200px]" title={run.error}>
                                {run.error}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
