"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  Clock,
  Loader2,
  Pause,
  Play,
  PlayCircle,
  Plus,
  Ticket,
  Trash2,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";

interface Trigger {
  id: string;
  type: "manual" | "schedule" | "webhook" | "ticket";
  config: Record<string, any> | null;
  enabled: boolean;
  lastFiredAt: string | null;
  nextFireAt: string | null;
}

interface TaskConfig {
  id: string;
  name: string;
  description: string | null;
  title: string;
  repoUrl: string;
  repoBranch: string;
  agentType: string | null;
  enabled: boolean;
  createdAt: string;
  triggers?: Trigger[];
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const delta = date.getTime() - Date.now();
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60_000);
  const hrs = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  if (mins < 60) return `${delta < 0 ? "" : "in "}${mins}m${delta < 0 ? " ago" : ""}`;
  if (hrs < 48) return `${delta < 0 ? "" : "in "}${hrs}h${delta < 0 ? " ago" : ""}`;
  return `${delta < 0 ? "" : "in "}${days}d${delta < 0 ? " ago" : ""}`;
}

function repoShortName(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return url;
  }
}

export default function ScheduledTasksPage() {
  usePageTitle("Scheduled Tasks");
  const [configs, setConfigs] = useState<TaskConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.listTaskConfigs();
      const withTriggers = await Promise.all(
        res.taskConfigs.map(async (c: TaskConfig) => {
          try {
            const t = await api.listTaskConfigTriggers(c.id);
            return { ...c, triggers: t.triggers };
          } catch {
            return { ...c, triggers: [] };
          }
        }),
      );
      setConfigs(withTriggers);
    } catch (err) {
      toast.error("Failed to load scheduled tasks", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggleEnabled = async (config: TaskConfig) => {
    setBusyId(config.id);
    try {
      await api.updateTaskConfig(config.id, { enabled: !config.enabled });
      await load();
    } catch (err) {
      toast.error("Failed to update", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (config: TaskConfig) => {
    setBusyId(config.id);
    try {
      const res = await api.runTaskConfig(config.id);
      toast.success("Task queued", {
        description: `Spawned task ${res.taskId.slice(0, 8)} from "${config.name}".`,
      });
    } catch (err) {
      toast.error("Failed to run", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (config: TaskConfig) => {
    if (!confirm(`Delete "${config.name}"? This removes the schedule and all its triggers.`))
      return;
    setBusyId(config.id);
    try {
      await api.deleteTaskConfig(config.id);
      await load();
    } catch (err) {
      toast.error("Failed to delete", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scheduled Tasks</h1>
          <p className="text-sm text-text-muted mt-1">
            Reusable task blueprints that spawn fresh tasks on a schedule, webhook, ticket event, or
            manual run.
          </p>
        </div>
        <Link
          href="/tasks/new"
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
        >
          <Plus className="w-4 h-4" />
          New
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-text-muted py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      ) : configs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <Clock className="w-8 h-8 text-text-muted mx-auto mb-3" />
          <p className="text-sm text-text-muted">
            No scheduled tasks yet. Create one from{" "}
            <Link href="/tasks/new" className="text-primary hover:underline">
              New Task
            </Link>{" "}
            and pick <strong>Schedule</strong> instead of Run now.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((config) => {
            const schedTrigger = config.triggers?.find((t) => t.type === "schedule");
            const webhookTrigger = config.triggers?.find((t) => t.type === "webhook");
            const ticketTrigger = config.triggers?.find((t) => t.type === "ticket");
            return (
              <div
                key={config.id}
                className="rounded-lg border border-border bg-bg-card p-4 hover:border-primary/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <Link href={`/tasks/scheduled/${config.id}`} className="flex-1 min-w-0 block">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${config.enabled ? "bg-primary" : "bg-text-muted/40"}`}
                      />
                      <h2 className="text-base font-medium truncate">{config.name}</h2>
                    </div>
                    <p className="text-xs text-text-muted truncate mb-2">
                      {repoShortName(config.repoUrl)} · {config.repoBranch} ·{" "}
                      {config.agentType ?? "default agent"}
                    </p>
                    <div className="flex flex-wrap gap-3 text-xs text-text-muted">
                      {schedTrigger && (
                        <span className="inline-flex items-center gap-1.5">
                          <Clock className="w-3 h-3" />
                          <code className="font-mono bg-bg px-1 py-0.5 rounded">
                            {schedTrigger.config?.cronExpression}
                          </code>
                        </span>
                      )}
                      {webhookTrigger && (
                        <span className="inline-flex items-center gap-1.5">
                          <Webhook className="w-3 h-3" />
                          {webhookTrigger.config?.path}
                        </span>
                      )}
                      {ticketTrigger && (
                        <span className="inline-flex items-center gap-1.5">
                          <Ticket className="w-3 h-3" />
                          {ticketTrigger.config?.source}
                          {Array.isArray(ticketTrigger.config?.labels) &&
                            ticketTrigger.config!.labels.length > 0 &&
                            ` [${(ticketTrigger.config!.labels as string[]).join(", ")}]`}
                        </span>
                      )}
                      {schedTrigger && (
                        <>
                          <span>Next: {formatRelative(schedTrigger.nextFireAt)}</span>
                          <span>Last: {formatRelative(schedTrigger.lastFiredAt)}</span>
                        </>
                      )}
                    </div>
                  </Link>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => runNow(config)}
                      disabled={busyId === config.id}
                      title="Run now"
                      className="p-2 rounded hover:bg-bg-hover text-text-muted hover:text-primary transition-colors disabled:opacity-50"
                    >
                      <PlayCircle className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => toggleEnabled(config)}
                      disabled={busyId === config.id}
                      title={config.enabled ? "Pause" : "Resume"}
                      className="p-2 rounded hover:bg-bg-hover text-text-muted hover:text-text transition-colors disabled:opacity-50"
                    >
                      {config.enabled ? (
                        <Pause className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      onClick={() => remove(config)}
                      disabled={busyId === config.id}
                      title="Delete"
                      className="p-2 rounded hover:bg-bg-hover text-text-muted hover:text-danger transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
