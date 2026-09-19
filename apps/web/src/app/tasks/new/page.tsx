"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { NumberInput } from "@/components/number-input";
import { ModeCard } from "@/components/mode-card";
import {
  Loader2,
  Sparkles,
  Link2,
  Clock,
  Play,
  GitPullRequest,
  Terminal,
  GitBranch as GitBranchIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TriggerSelector, type TriggerConfig, cronIsValid } from "@/components/trigger-selector";
import { useLocalHosts } from "@/hooks/use-local-hosts";
import {
  CLUSTER_RUN_LOCATION,
  RunLocationPicker,
  agentRunsLocally,
  runLocationPayload,
  type RunLocationValue,
} from "@/components/run-location-picker";

type RunMode = "now" | "schedule";
type TaskMode = "repo" | "standalone";

const AGENTS: Array<{ value: string; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "opencode", label: "OpenCode (Experimental)" },
  { value: "gemini", label: "Google Gemini" },
  { value: "openclaw", label: "OpenClaw (Experimental)" },
  { value: "cursor", label: "Cursor" },
];

export default function NewTaskPage() {
  usePageTitle("New Task");
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  // Mode: repo-attached (produces PR) or standalone (agent run, no repo)
  const [mode, setMode] = useState<TaskMode>("repo");

  const [repos, setRepos] = useState<any[]>([]);
  const [reposLoading, setReposLoading] = useState(true);

  // Dependency state (repo tasks, run-now only)
  const [existingTasks, setExistingTasks] = useState<any[]>([]);
  const [selectedDeps, setSelectedDeps] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);

  // Run mode
  const [runMode, setRunMode] = useState<RunMode>("now");
  const [scheduleName, setScheduleName] = useState("");
  const [trigger, setTrigger] = useState<TriggerConfig>({
    type: "schedule",
    cronExpression: "0 9 * * *",
  });

  // Core form
  const [form, setForm] = useState({
    title: "",
    prompt: "",
    description: "",
    repoId: "",
    repoUrl: "",
    repoBranch: "main",
    agentType: "claude-code",
    priority: 100,
    maxRetries: 3,
  });

  // Where: an Optio pod, or a directory on one of the user's paired machines.
  // On a machine the picked checkout decides the repo (its git remote), so a
  // Task there needs no registered repo at all.
  const [location, setLocation] = useState<RunLocationValue>(CLUSTER_RUN_LOCATION);
  const [localRepoUrl, setLocalRepoUrl] = useState<string | null>(null);
  const { hosts: localHosts } = useLocalHosts();
  const isLocal = location.runTarget === "local";
  const localReady = !isLocal || (!!location.localHostId && !!location.localDir);
  const agentOk = !isLocal || agentRunsLocally(form.agentType);
  const effectiveRepoUrl = isLocal ? localRepoUrl : form.repoUrl;
  const canRunTask = repos.length > 0 || localHosts.length > 0;

  useEffect(() => {
    api
      .listRepos()
      .then((res) => {
        setRepos(res.repos);
        // Default to standalone when no repos are configured.
        if (res.repos.length === 0) setMode("standalone");
      })
      .catch(() => {})
      .finally(() => setReposLoading(false));
    api
      .listTasks({ limit: 100 })
      .then((res) => setExistingTasks(res.tasks))
      .catch(() => {});
  }, []);

  // A Task with no registered repos can still run in a checkout on a paired
  // machine — start there instead of on an empty repo list.
  useEffect(() => {
    if (mode === "repo" && !reposLoading && repos.length === 0 && localHosts.length > 0) {
      setLocation((l) => (l.runTarget === "local" ? l : { ...l, runTarget: "local" }));
    }
  }, [mode, reposLoading, repos.length, localHosts.length]);

  // When switching into repo mode or loading repos, pre-select the first.
  useEffect(() => {
    if (mode === "repo" && !form.repoId && repos.length > 0) {
      const first = repos[0];
      setForm((f) => ({
        ...f,
        repoId: first.id,
        repoUrl: first.repoUrl,
        repoBranch: first.defaultBranch ?? "main",
        agentType: first.defaultAgentType ?? f.agentType,
      }));
    }
  }, [mode, form.repoId, repos]);

  const handleRepoChange = (repoId: string) => {
    const repo = repos.find((r: any) => r.id === repoId);
    if (repo) {
      setForm((f) => ({
        ...f,
        repoId: repo.id,
        repoUrl: repo.repoUrl,
        repoBranch: repo.defaultBranch ?? "main",
        agentType: repo.defaultAgentType ?? f.agentType,
      }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (
        runMode === "schedule" &&
        trigger.type === "schedule" &&
        !cronIsValid(trigger.cronExpression)
      ) {
        toast.error("Invalid cron expression", {
          description: "Expected five space-separated fields.",
        });
        setLoading(false);
        return;
      }

      // Pick the unified `type` from the UI mode + run mode:
      //   mode=repo + runMode=now     → repo-task (ad-hoc)
      //   mode=repo + runMode=schedule → repo-blueprint + trigger
      //   mode=standalone             → standalone + optional trigger + optional run
      const apiType =
        mode === "standalone"
          ? "standalone"
          : runMode === "schedule"
            ? "repo-blueprint"
            : "repo-task";

      const created = await api.createTaskUnified({
        type: apiType,
        title: form.title,
        name: scheduleName.trim() || form.title.trim() || undefined,
        prompt: form.prompt,
        description: form.description || undefined,
        agentType: form.agentType,
        maxRetries: form.maxRetries,
        repoUrl: mode === "repo" ? (effectiveRepoUrl ?? undefined) : undefined,
        repoBranch: mode === "repo" ? form.repoBranch : undefined,
        priority: mode === "repo" ? form.priority : undefined,
        ...(selectedDeps.length > 0 && apiType === "repo-task" ? { dependsOn: selectedDeps } : {}),
        enabled: true,
        ...runLocationPayload(location),
      });
      const createdId = created.task.id as string;

      // Attach a trigger when scheduling.
      if (runMode === "schedule" && trigger.type !== "manual") {
        const config: Record<string, unknown> =
          trigger.type === "schedule"
            ? { cronExpression: trigger.cronExpression!.trim() }
            : trigger.type === "webhook"
              ? { path: trigger.webhookPath }
              : trigger.type === "ticket"
                ? {
                    source: trigger.ticketSource ?? "github",
                    ...(trigger.ticketLabels?.length ? { labels: trigger.ticketLabels } : {}),
                  }
                : {};
        await api.createTaskTrigger(createdId, {
          type: trigger.type,
          config,
          enabled: true,
        });
      }

      // Standalone + Run now → create workflow THEN kick off a run.
      if (apiType === "standalone" && runMode === "now") {
        const run = await api.createTaskRun(createdId);
        toast.success("Task started");
        router.push(`/jobs/${createdId}/runs/${run.runId}`);
        return;
      }

      if (apiType === "repo-task") {
        toast.success("Task created", { description: `"${form.title}" has been queued.` });
        router.push(`/tasks/${createdId}`);
        return;
      }

      // scheduled (repo-blueprint or standalone with schedule)
      toast.success("Scheduled task created");
      router.push(
        apiType === "repo-blueprint" ? `/tasks/scheduled/${createdId}` : `/jobs/${createdId}`,
      );
    } catch (err) {
      toast.error("Failed to create task", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  };

  const canSubmit =
    !loading &&
    form.title &&
    form.prompt &&
    (mode !== "repo" || !!effectiveRepoUrl) &&
    localReady &&
    agentOk;

  const submitLabel =
    runMode === "schedule"
      ? mode === "repo"
        ? "Save scheduled Task"
        : "Save scheduled Job"
      : mode === "repo"
        ? "Start Task (opens a PR)"
        : "Start Task";

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">New Task</h1>
      <p className="text-sm text-text-muted mb-6">
        Configure an agent to do something. Pick a mode first — Tasks open a PR against a repo, Jobs
        run with no repo.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ── Mode picker (the first, biggest choice) ──────────────────── */}
        <div>
          <div className="text-xs uppercase tracking-wider text-text-muted/60 mb-2">Task type</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ModeCard
              active={mode === "repo"}
              onClick={() => setMode("repo")}
              icon={<GitPullRequest className="w-5 h-5" />}
              title="Task"
              subtitle="Opens a PR against your repo"
              description="Agent clones a repo, modifies code on a branch, and opens a pull request. Full CI + review pipeline."
              disabled={!canRunTask}
              disabledHint={
                !canRunTask ? (
                  <>
                    No repos yet —{" "}
                    <a href="/repos" className="text-primary hover:underline">
                      add one
                    </a>{" "}
                    or pair a machine with <code className="font-mono">optio local up</code>.
                  </>
                ) : null
              }
            />
            <ModeCard
              active={mode === "standalone"}
              onClick={() => setMode("standalone")}
              icon={<Terminal className="w-5 h-5" />}
              title="Job"
              subtitle="Runs the agent, no PR"
              description="Agent runs in an isolated pod with no git checkout. Output is logs + side effects via Connections."
            />
          </div>
        </div>

        {/* ── Outcome banner ──────────────────────────────────── */}
        <div
          className={cn(
            "flex items-start gap-2 px-3 py-2 rounded-md border text-xs",
            mode === "repo"
              ? "border-primary/20 bg-primary/5 text-primary"
              : "border-text-muted/20 bg-bg-card text-text-muted",
          )}
        >
          {mode === "repo" ? (
            <GitPullRequest className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          ) : (
            <Terminal className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          )}
          <span>
            {mode === "repo"
              ? isLocal
                ? "When this task runs, the agent works in your own checkout on your machine, makes changes on a branch, and opens a PR — ready for CI and review. The session also shows up under Local."
                : "When this task runs, the agent will clone the selected repo, make changes on a branch, and open a PR — ready for CI and review."
              : isLocal
                ? "When this task runs, the agent executes in a directory on your machine with your local CLI and login. The session shows up under Local; the run records its outcome and cost."
                : "When this task runs, the agent will execute in an isolated pod with no repo checkout. Results land in the run logs; side effects happen through Connections."}
          </span>
        </div>

        {/* ── When ──────────────────────────────────── */}
        <div>
          <div className="text-xs uppercase tracking-wider text-text-muted/60 mb-2">When</div>
          <div className="flex gap-2 p-1 rounded-lg bg-bg-card border border-border w-fit">
            <button
              type="button"
              onClick={() => setRunMode("now")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                runMode === "now" ? "bg-primary text-white" : "text-text-muted hover:text-text"
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              Run now
            </button>
            <button
              type="button"
              onClick={() => setRunMode("schedule")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                runMode === "schedule" ? "bg-primary text-white" : "text-text-muted hover:text-text"
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              Schedule
            </button>
          </div>
        </div>

        {/* ── What ──────────────────────────────────── */}
        <div className="space-y-4">
          <div className="text-xs uppercase tracking-wider text-text-muted/60">What</div>
          <div>
            <label className="block text-sm text-text-muted mb-1.5">
              {runMode === "schedule" ? "Task title template" : "Title"}
            </label>
            <input
              type="text"
              required
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder={
                mode === "repo" ? "Fix dependency vulnerabilities" : "Weekly security report"
              }
              className="w-full px-3 py-2 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm text-text-muted mb-1.5">Prompt</label>
            <textarea
              required
              rows={6}
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
              placeholder={
                mode === "repo"
                  ? "Describe the change. Be specific about files to modify and expected behavior."
                  : "Describe what the agent should do. Reference Connections for external systems."
              }
              className="w-full px-3 py-2 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors resize-y"
            />
            <p className="text-xs text-text-muted/60 mt-1">
              Supports {"{{param}}"} substitution on scheduled/webhook firings.
            </p>
          </div>
        </div>

        {/* ── When (schedule details) ──────────────────────────────────── */}
        {runMode === "schedule" && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-text-muted mb-1.5">Schedule name</label>
              <input
                type="text"
                value={scheduleName}
                onChange={(e) => setScheduleName(e.target.value)}
                placeholder={form.title || "e.g. Daily CVE patch"}
                className="w-full px-3 py-2 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
              />
              <p className="text-xs text-text-muted/60 mt-1">
                Defaults to the task title if left blank.
              </p>
            </div>
            <TriggerSelector value={trigger} onChange={setTrigger} hideManual label="Trigger" />
          </div>
        )}

        {/* ── Where ────────────────────────────────────────────────────── */}
        <div>
          <div className="text-xs uppercase tracking-wider text-text-muted/60 mb-2">Where</div>
          <div className="space-y-3">
            <RunLocationPicker
              value={location}
              onChange={setLocation}
              kind={mode === "repo" ? "task" : "job"}
              agentType={form.agentType}
              onRepoUrlChange={setLocalRepoUrl}
            />

            {mode === "repo" && (
              <div className="p-4 rounded-lg border border-border bg-bg-card/60 space-y-3">
                {isLocal ? (
                  <div>
                    <label className="block text-sm text-text-muted mb-1.5">Base branch</label>
                    <div className="flex items-center gap-2">
                      <GitBranchIcon className="w-3.5 h-3.5 text-text-muted" />
                      <input
                        type="text"
                        value={form.repoBranch}
                        onChange={(e) => setForm((f) => ({ ...f, repoBranch: e.target.value }))}
                        className="flex-1 px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
                      />
                    </div>
                    <p className="text-xs text-text-muted/60 mt-1">
                      The agent branches off this in your checkout and opens the PR against it.
                    </p>
                  </div>
                ) : reposLoading ? (
                  <div className="flex items-center gap-2 text-text-muted text-sm py-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading repos...
                  </div>
                ) : repos.length > 0 ? (
                  <>
                    <div>
                      <label className="block text-sm text-text-muted mb-1.5">Repository</label>
                      <select
                        required
                        value={form.repoId}
                        onChange={(e) => handleRepoChange(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
                      >
                        {repos.map((repo: any) => (
                          <option key={repo.id} value={repo.id}>
                            {repo.fullName} ({repo.defaultBranch})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm text-text-muted mb-1.5">Branch</label>
                      <div className="flex items-center gap-2">
                        <GitBranchIcon className="w-3.5 h-3.5 text-text-muted" />
                        <input
                          type="text"
                          value={form.repoBranch}
                          onChange={(e) => setForm((f) => ({ ...f, repoBranch: e.target.value }))}
                          className="flex-1 px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-text-muted py-2">
                    No repos configured.{" "}
                    <a href="/repos" className="text-primary hover:underline">
                      Add a repo
                    </a>{" "}
                    first, pick My machine above, or switch to Job.
                  </div>
                )}

                {runMode === "now" && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowDeps(!showDeps)}
                      className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text transition-colors"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      Dependencies {selectedDeps.length > 0 && `(${selectedDeps.length})`}
                    </button>
                    {showDeps && (
                      <div className="mt-2 p-3 rounded-lg bg-bg border border-border">
                        <p className="text-xs text-text-muted/60 mb-2">
                          Wait for these tasks to complete first.
                        </p>
                        {existingTasks.length === 0 ? (
                          <p className="text-xs text-text-muted">No existing tasks.</p>
                        ) : (
                          <div className="max-h-40 overflow-y-auto space-y-1">
                            {existingTasks
                              .filter((t) => !["completed", "cancelled"].includes(t.state))
                              .map((t) => (
                                <label
                                  key={t.id}
                                  className="flex items-center gap-2 text-xs py-0.5 cursor-pointer hover:bg-bg-hover rounded px-1"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedDeps.includes(t.id)}
                                    onChange={(e) =>
                                      setSelectedDeps((prev) =>
                                        e.target.checked
                                          ? [...prev, t.id]
                                          : prev.filter((id) => id !== t.id),
                                      )
                                    }
                                  />
                                  <span className="truncate flex-1">{t.title}</span>
                                  <span className="text-text-muted shrink-0">{t.state}</span>
                                </label>
                              ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Who (agent) ──────────────────────────────────── */}
        <div>
          <div className="text-xs uppercase tracking-wider text-text-muted/60 mb-2">Who</div>
          <label className="block text-sm text-text-muted mb-1.5">Agent</label>
          <select
            value={form.agentType}
            onChange={(e) => setForm((f) => ({ ...f, agentType: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
          >
            {AGENTS.map((a) => (
              <option
                key={a.value}
                value={a.value}
                disabled={isLocal && !agentRunsLocally(a.value)}
              >
                {a.label}
                {isLocal && !agentRunsLocally(a.value) ? " — pods only" : ""}
              </option>
            ))}
          </select>
          {!agentOk && (
            <p className="text-xs text-error mt-1">
              {form.agentType} can't run on your machine — pick another agent or switch back to an
              Optio pod.
            </p>
          )}
        </div>

        {/* ── Why ──────────────────────────────────── */}
        <div>
          <div className="text-xs uppercase tracking-wider text-text-muted/60 mb-2">Why</div>
          <label className="block text-sm text-text-muted mb-1.5">
            Description <span className="text-text-muted/60">(optional)</span>
          </label>
          <input
            type="text"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Why does this task exist? Who asked for it?"
            className="w-full px-3 py-2 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
          />
        </div>

        {/* Priority (repo tasks) */}
        {mode === "repo" && (
          <div>
            <label className="block text-sm text-text-muted mb-1.5">Priority</label>
            <p className="text-xs text-text-muted/60 mb-1.5">
              Lower number = higher priority. Default 100.
            </p>
            <NumberInput
              min={1}
              max={1000}
              value={form.priority}
              onChange={(v) => setForm((f) => ({ ...f, priority: v }))}
              fallback={100}
              className="w-24 px-3 py-2 rounded-lg bg-bg-card border border-border text-sm"
            />
          </div>
        )}

        {/* Submit */}
        <div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex items-center gap-2 px-6 py-2.5 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : runMode === "schedule" ? (
              <Clock className="w-4 h-4" />
            ) : mode === "repo" ? (
              <GitPullRequest className="w-4 h-4" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            {loading ? "Creating..." : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
