"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  ArrowLeft,
  Clock,
  Loader2,
  Pause,
  Pencil,
  Play,
  PlayCircle,
  Plus,
  Ticket,
  Trash2,
  Webhook,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { TriggerSelector, type TriggerConfig, cronIsValid } from "@/components/trigger-selector";

/**
 * A scheduled Task's runs and actions. Its five answers (when / where / who /
 * what / then) are edited in the unified work form at /work/:id/edit;
 * this page shows what it is and what it has done.
 */

type Tab = "runs" | "triggers";

interface TaskConfig {
  id: string;
  name: string;
  description: string | null;
  title: string;
  prompt: string;
  repoUrl: string;
  repoBranch: string;
  agentType: string | null;
  maxRetries: number;
  priority: number;
  runTarget?: "cluster" | "local";
  localHostId?: string | null;
  localDir?: string | null;
  localSessionMode?: "headless" | "interactive" | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Trigger {
  id: string;
  type: "manual" | "schedule" | "webhook" | "ticket";
  config: Record<string, any> | null;
  enabled: boolean;
  lastFiredAt: string | null;
  nextFireAt: string | null;
}

function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const delta = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(delta);
  const mins = Math.round(abs / 60_000);
  const hrs = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  if (mins < 60) return `${delta < 0 ? "" : "in "}${mins}m${delta < 0 ? " ago" : ""}`;
  if (hrs < 48) return `${delta < 0 ? "" : "in "}${hrs}h${delta < 0 ? " ago" : ""}`;
  return `${delta < 0 ? "" : "in "}${days}d${delta < 0 ? " ago" : ""}`;
}

export default function ScheduledTaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);
  return id ? <ScheduledTaskDetailInner id={id} /> : null;
}

function ScheduledTaskDetailInner({ id }: { id: string }) {
  const router = useRouter();
  const [config, setConfig] = useState<TaskConfig | null>(null);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("runs");
  const [addingTrigger, setAddingTrigger] = useState(false);
  const [newTrigger, setNewTrigger] = useState<TriggerConfig>({
    type: "schedule",
    cronExpression: "0 9 * * *",
  });

  usePageTitle(config?.name ?? "Scheduled Task");

  const load = async () => {
    setLoading(true);
    try {
      const [cfg, trg] = await Promise.all([api.getTaskConfig(id), api.listTaskConfigTriggers(id)]);
      setConfig(cfg.taskConfig);
      setTriggers(trg.triggers);
    } catch (err) {
      toast.error("Failed to load", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const scheduleTrigger = useMemo(() => triggers.find((t) => t.type === "schedule"), [triggers]);

  const runNow = async () => {
    try {
      const res = await api.runTaskConfig(id);
      toast.success("Task queued", { description: `Spawned ${res.taskId.slice(0, 8)}` });
    } catch (err) {
      toast.error("Failed to run", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const toggleEnabled = async () => {
    if (!config) return;
    try {
      await api.updateTaskConfig(id, { enabled: !config.enabled });
      await load();
    } catch (err) {
      toast.error("Update failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const deleteConfig = async () => {
    if (!confirm(`Delete "${config?.name}"? This removes all triggers.`)) return;
    try {
      await api.deleteTaskConfig(id);
      router.push("/work?view=recurring");
    } catch (err) {
      toast.error("Delete failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const addTrigger = async () => {
    if (newTrigger.type === "schedule" && !cronIsValid(newTrigger.cronExpression)) {
      toast.error("Invalid cron expression");
      return;
    }
    try {
      const cfg: Record<string, unknown> =
        newTrigger.type === "schedule"
          ? { cronExpression: newTrigger.cronExpression!.trim() }
          : newTrigger.type === "webhook"
            ? { path: newTrigger.webhookPath }
            : newTrigger.type === "ticket"
              ? {
                  source: newTrigger.ticketSource ?? "github",
                  ...(newTrigger.ticketLabels?.length ? { labels: newTrigger.ticketLabels } : {}),
                }
              : {};
      await api.createTaskConfigTrigger(id, {
        type: newTrigger.type,
        config: cfg,
        enabled: true,
      });
      setAddingTrigger(false);
      await load();
    } catch (err) {
      toast.error("Add trigger failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const toggleTrigger = async (t: Trigger) => {
    try {
      await api.updateTaskConfigTrigger(id, t.id, { enabled: !t.enabled });
      await load();
    } catch (err) {
      toast.error("Update failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const deleteTrigger = async (t: Trigger) => {
    if (!confirm(`Delete ${t.type} trigger?`)) return;
    try {
      await api.deleteTaskConfigTrigger(id, t.id);
      await load();
    } catch (err) {
      toast.error("Delete failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading...
      </div>
    );
  }
  if (!config) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link
          href="/work?view=recurring"
          className="text-sm text-text-muted hover:text-text flex items-center gap-1"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </Link>
        <p className="mt-4 text-text-muted">Scheduled task not found.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        href="/work?view=recurring"
        className="text-sm text-text-muted hover:text-text flex items-center gap-1 mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Work
      </Link>

      <div className="flex items-start justify-between mb-2 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`inline-block w-2 h-2 rounded-full ${config.enabled ? "bg-primary" : "bg-text-muted/40"}`}
            />
            <h1 className="text-2xl font-semibold tracking-tight">{config.name}</h1>
          </div>
          {config.description && <p className="text-sm text-text-muted">{config.description}</p>}
          <p className="text-xs text-text-muted/80 mt-1">
            {config.agentType ?? "claude-code"} ·{" "}
            {config.runTarget === "local"
              ? `on your machine · ${config.localDir ?? ""}`
              : config.repoUrl.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "")}{" "}
            · {config.repoBranch} · opens a PR each run
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Link
            href={`/work/${id}/edit`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover"
          >
            <Pencil className="w-4 h-4" /> Edit
          </Link>
          <button
            onClick={runNow}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-bg-card border border-border text-sm text-text hover:bg-bg-hover"
          >
            <PlayCircle className="w-4 h-4" /> Run now
          </button>
          <button
            onClick={toggleEnabled}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-bg-card border border-border text-sm text-text hover:bg-bg-hover"
          >
            {config.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {config.enabled ? "Pause" : "Resume"}
          </button>
          <button
            onClick={deleteConfig}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-bg-card border border-border text-sm text-danger hover:bg-danger/5"
          >
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        </div>
      </div>

      {scheduleTrigger && scheduleTrigger.enabled && config.enabled && (
        <div className="mb-6 p-3 rounded-lg bg-primary/5 border border-primary/20 flex items-center gap-3">
          <Clock className="w-4 h-4 text-primary" />
          <div className="flex-1 text-sm">
            Next run {formatRelative(scheduleTrigger.nextFireAt)} —{" "}
            <span className="text-text-muted">{formatAbsolute(scheduleTrigger.nextFireAt)}</span>
          </div>
        </div>
      )}

      {!config.enabled && (
        <div className="mb-6 p-3 rounded-lg bg-bg-card border border-border flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-text-muted" />
          <div className="flex-1 text-sm text-text-muted">
            Paused — triggers will not fire while disabled.
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-border mb-6">
        {(["runs", "triggers"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors capitalize ${
              tab === t
                ? "border-primary text-text"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            {t}
            {t === "triggers" && ` (${triggers.length})`}
          </button>
        ))}
      </div>

      {tab === "triggers" && (
        <div className="space-y-3">
          {triggers.length === 0 && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-text-muted">
              No triggers yet. Add one to make this run automatically.
            </div>
          )}
          {triggers.map((t) => (
            <div key={t.id} className="rounded-lg border border-border bg-bg-card p-4">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {t.type === "schedule" && <Clock className="w-4 h-4 text-text-muted" />}
                    {t.type === "webhook" && <Webhook className="w-4 h-4 text-text-muted" />}
                    {t.type === "ticket" && <Ticket className="w-4 h-4 text-text-muted" />}
                    <span className="font-medium capitalize">{t.type}</span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${t.enabled ? "bg-primary/10 text-primary" : "bg-bg text-text-muted"}`}
                    >
                      {t.enabled ? "enabled" : "paused"}
                    </span>
                  </div>
                  {t.type === "schedule" && (
                    <>
                      <code className="text-xs font-mono bg-bg px-2 py-1 rounded">
                        {t.config?.cronExpression}
                      </code>
                      <div className="mt-2 text-xs text-text-muted">
                        Next {formatRelative(t.nextFireAt)} · Last {formatRelative(t.lastFiredAt)}
                      </div>
                    </>
                  )}
                  {t.type === "webhook" && (
                    <code className="text-xs font-mono bg-bg px-2 py-1 rounded">
                      POST /api/hooks/{t.config?.path}
                    </code>
                  )}
                  {t.type === "ticket" && (
                    <code className="text-xs font-mono bg-bg px-2 py-1 rounded">
                      source={String(t.config?.source)}
                      {Array.isArray(t.config?.labels) &&
                        ` labels=${(t.config!.labels as string[]).join(",")}`}
                    </code>
                  )}
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => toggleTrigger(t)}
                    className="p-2 rounded hover:bg-bg-hover text-text-muted hover:text-text"
                    title={t.enabled ? "Pause" : "Resume"}
                  >
                    {t.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => deleteTrigger(t)}
                    className="p-2 rounded hover:bg-bg-hover text-text-muted hover:text-danger"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}

          {!addingTrigger ? (
            <button
              onClick={() => setAddingTrigger(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-bg-card border border-border text-sm text-text-muted hover:text-text"
            >
              <Plus className="w-4 h-4" /> Add trigger
            </button>
          ) : (
            <div className="rounded-lg border border-border bg-bg-card p-4 space-y-3">
              <TriggerSelector value={newTrigger} onChange={setNewTrigger} hideManual />
              <div className="flex gap-2">
                <button
                  onClick={addTrigger}
                  className="px-3 py-1.5 rounded-md bg-primary text-white text-sm hover:bg-primary-hover"
                >
                  Add
                </button>
                <button
                  onClick={() => setAddingTrigger(false)}
                  className="px-3 py-1.5 rounded-md border border-border text-sm text-text-muted hover:text-text"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "runs" && <RunsTab taskConfigId={id} />}
    </div>
  );
}

function RunsTab({ taskConfigId }: { taskConfigId: string }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .searchTasks({ limit: 50 })
      .then((res) => {
        const matching = (res.tasks ?? []).filter(
          (t: any) => (t.metadata as Record<string, unknown>)?.taskConfigId === taskConfigId,
        );
        setRuns(matching);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskConfigId]);

  if (loading) return <div className="text-sm text-text-muted">Loading runs...</div>;
  if (runs.length === 0)
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-text-muted">
        No runs yet.
      </div>
    );

  return (
    <div className="space-y-2">
      {runs.map((r) => (
        <Link
          key={r.id}
          href={`/tasks/${r.id}`}
          className="block rounded-lg border border-border bg-bg-card p-3 hover:border-primary/60 transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{r.title}</div>
              <div className="text-xs text-text-muted">{formatRelative(r.createdAt)}</div>
            </div>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                r.state === "completed"
                  ? "bg-green-500/10 text-green-500"
                  : r.state === "failed"
                    ? "bg-red-500/10 text-red-500"
                    : "bg-bg text-text-muted"
              }`}
            >
              {r.state}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
