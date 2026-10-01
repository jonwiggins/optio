/**
 * Local runs: Jobs and Repo Tasks whose run location is the owner's own
 * machine instead of an Optio pod. See docs/optio-local.md ("Local runs")
 * and docs/tasks.md.
 *
 * A local run is an ordinary `workflow_runs` / `tasks` row plus a
 * `local_terminals` row that executes it through the Optio Local daemon:
 *
 *   worker (queued run) ─► dispatchLocal*() ─► createTerminal({kind:"agent"})
 *   daemon frames ─► local-terminal-service ─► syncLinkedRun() ─► run state
 *
 * The daemon is the authority on the process; this module maps the terminal
 * lifecycle onto the run lifecycle:
 *
 *   terminal pending             run stays queued (host offline → parked)
 *   terminal launching/running   job run running; task provisioning → running
 *   PR link in the output        task pr_opened (the PR watcher takes over)
 *   terminal exited 0            job completed; task completed (or pr_opened)
 *   terminal exited ≠0 / error   run failed
 *
 * Every step is idempotent and CAS-guarded: daemon frames, the reconciler's
 * resync, retries, and user actions all race with each other.
 */
import { modelProviderIdFrom } from "@optio/shared";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  TASK_BRANCH_PREFIX,
  TaskState,
  WorkflowRunState,
  localAgentParams,
  normalizeRepoUrl,
  parseRepoUrl,
  prsFromTranscript,
  toLocalAgentKind,
  type LocalAgentKind,
  type LocalAgentSessionMode,
  type LocalTerminalSpec,
  type PrToolCallMatch,
  type RunLocation,
  type RunTarget,
} from "@optio/shared";
import { db } from "../db/client.js";
import { localTerminalTranscripts, tasks, workDefinitions, workflowRuns } from "../db/schema.js";
import { logger } from "../logger.js";
import { canAccessHost, getHost, isDirAllowed, type LocalHostRow } from "./local-host-service.js";
import {
  KILLED_REASON,
  createTerminal,
  getTerminal,
  killTerminal,
  type LocalTerminalRow,
} from "./local-terminal-service.js";
import * as taskService from "./task-service.js";
import { detectTaskPrs } from "./task-pr-service.js";
import { isCommandJob, transitionWorkflowRunCas, type Workflow } from "./workflow-service.js";

type TaskRow = typeof tasks.$inferSelect;
type WorkflowRunRow = typeof workflowRuns.$inferSelect;

export const CLUSTER_LOCATION: RunLocation = Object.freeze({
  runTarget: "cluster",
  localHostId: null,
  localDir: null,
  localSessionMode: null,
});

const LIVE_STATES: ReadonlySet<LocalTerminalRow["state"]> = new Set([
  "pending",
  "launching",
  "running",
]);

export function isLiveTerminalState(state: LocalTerminalRow["state"]): boolean {
  return LIVE_STATES.has(state);
}

// ── Validation (routes) ──────────────────────────────────────────────────────

export interface RunLocationInput {
  runTarget?: RunTarget | null;
  localHostId?: string | null;
  localDir?: string | null;
  localSessionMode?: LocalAgentSessionMode | null;
  /** The run's agent runtime; a local host can only launch the CLIs the daemon knows. */
  agentType?: string | null;
  /** Repo Tasks: the directory must be a checkout of this repo when the host detected a remote. */
  repoUrl?: string | null;
}

export type RunLocationCheck = { ok: true; location: RunLocation } | { ok: false; error: string };

/** The allowlist entry `dir` lives in (itself or an ancestor), longest match. */
export function allowlistEntryFor(
  host: Pick<LocalHostRow, "dirs">,
  dir: string,
): { path: string; repoUrl?: string } | null {
  const requested = dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
  let best: { path: string; repoUrl?: string } | null = null;
  for (const d of host.dirs ?? []) {
    const allowed = d.path.length > 1 && d.path.endsWith("/") ? d.path.slice(0, -1) : d.path;
    if (requested === allowed || requested.startsWith(`${allowed}/`)) {
      if (!best || allowed.length > best.path.length) best = d;
    }
  }
  return best;
}

/**
 * Check a run location the caller asked for. `cluster` needs nothing. `local`
 * needs a host the caller owns, a directory inside its allowlist, an agent
 * the daemon can launch, and — for Repo Tasks — a directory that is a
 * checkout of the task's repo (when the host reported the dir's remote).
 * Returns the normalized location to persist, or a user-facing error.
 */
export async function validateRunLocation(
  input: RunLocationInput,
  userId: string | null | undefined,
): Promise<RunLocationCheck> {
  const target: RunTarget = input.runTarget ?? "cluster";
  if (target === "cluster") return { ok: true, location: CLUSTER_LOCATION };

  if (!input.localHostId) return { ok: false, error: "Pick the machine this should run on" };
  if (!input.localDir?.trim()) {
    return { ok: false, error: "Pick a directory on the machine to run in" };
  }
  if (input.agentType && !toLocalAgentKind(input.agentType)) {
    return {
      ok: false,
      error: `${input.agentType} can't run on your machine — pick Claude Code, Codex, Cursor, Gemini, or OpenCode`,
    };
  }
  const host = await getHost(input.localHostId);
  if (!host || !canAccessHost(host, userId)) return { ok: false, error: "Host not found" };

  const dir = input.localDir.trim();
  if (!isDirAllowed(host, dir)) {
    return {
      ok: false,
      error: `${dir} is not in ${host.name}'s directory list — run \`optio local add <dir>\` on that machine`,
    };
  }
  if (input.repoUrl) {
    const entry = allowlistEntryFor(host, dir);
    if (entry?.repoUrl && normalizeRepoUrl(entry.repoUrl) !== normalizeRepoUrl(input.repoUrl)) {
      return {
        ok: false,
        error: `${dir} is a checkout of ${entry.repoUrl}, not ${input.repoUrl}`,
      };
    }
  }
  return {
    ok: true,
    location: {
      runTarget: "local",
      localHostId: host.id,
      localDir: dir,
      localSessionMode: input.localSessionMode ?? "headless",
    },
  };
}

// ── Dispatch (workers) ───────────────────────────────────────────────────────

/**
 * The model a local run should pass to its CLI (`--model`), from the run's
 * per-run agent options. See `localAgentParams` for everything a run on a
 * machine takes (model, effort, Claude Code's permission mode).
 */
export function localModelFor(
  agentType: string,
  agentOptions: Record<string, unknown> | null | undefined,
): string | undefined {
  return localAgentParams(agentType, agentOptions).model;
}

/**
 * Re-check a persisted location at dispatch time: hosts get unpaired, dir
 * lists change. `agentType` null is a shell command, which needs no agent on
 * the machine (and resolves to `agent: null`).
 */
async function resolveLocalHost(input: {
  agentType: string | null;
  localHostId: string | null;
  localDir: string | null;
  noun: string;
}): Promise<{ host: LocalHostRow; agent: LocalAgentKind | null; dir: string } | { error: string }> {
  const agent = input.agentType === null ? null : toLocalAgentKind(input.agentType);
  if (input.agentType !== null && !agent) {
    return {
      error: `Agent "${input.agentType}" can't run on a local host (only Claude Code, Codex, Cursor, Gemini, or OpenCode can)`,
    };
  }
  if (!input.localHostId || !input.localDir) {
    return { error: `This ${input.noun} has no local machine / directory configured` };
  }
  const host = await getHost(input.localHostId);
  if (!host) {
    return { error: `The machine this ${input.noun} runs on was unpaired — pick a host again` };
  }
  if (!isDirAllowed(host, input.localDir)) {
    return { error: `${input.localDir} is no longer in ${host.name}'s directory list` };
  }
  return { host, agent, dir: input.localDir };
}

async function liveTerminal(id: string | null | undefined): Promise<LocalTerminalRow | null> {
  if (!id) return null;
  const row = await getTerminal(id);
  return row && isLiveTerminalState(row.state) ? row : null;
}

/** How long a dispatcher that lost the claim waits for the winner's terminal row. */
const CLAIM_WAIT_ATTEMPTS = 20;
const CLAIM_WAIT_MS = 25;

/**
 * The terminal the dispatcher that won the claim is creating. It stamps the
 * id on the run first and inserts the row right after, so a loser reading in
 * between gives the row a moment to land instead of reporting no terminal.
 */
async function claimedTerminal(id: string | null | undefined): Promise<LocalTerminalRow | null> {
  if (!id) return null;
  for (let attempt = 0; ; attempt++) {
    const row = await getTerminal(id);
    if (row) return isLiveTerminalState(row.state) ? row : null;
    if (attempt >= CLAIM_WAIT_ATTEMPTS) return null;
    await new Promise((resolve) => setTimeout(resolve, CLAIM_WAIT_MS));
  }
}

/**
 * Spawn (or re-attach to) the local terminal that executes a queued Job run.
 * Called by the workflow worker instead of provisioning a pod. Idempotent:
 * a run whose current terminal is still alive is left alone, so the
 * reconciler's periodic re-enqueue can't fork a second agent.
 *
 * The future terminal id is stamped on the run under CAS *before* the
 * terminal exists, so two concurrent dispatches can't both spawn. The run
 * stays `queued` while the terminal is parked (host offline); it moves to
 * `running` as soon as the daemon starts the process (see syncLinkedRun).
 */
export async function dispatchLocalWorkflowRun(
  run: WorkflowRunRow,
  workflow: Workflow,
  renderedPrompt: string,
): Promise<LocalTerminalRow | null> {
  const log = logger.child({ workflowRunId: run.id, workflowId: workflow.id, local: true });
  const existing = await liveTerminal(run.localTerminalId);
  if (existing) return existing;

  const command = isCommandJob(workflow);
  const resolved = await resolveLocalHost({
    agentType: command ? null : workflow.agentRuntime,
    localHostId: workflow.localHostId,
    localDir: workflow.localDir,
    noun: "job",
  });
  if ("error" in resolved) {
    log.warn({ error: resolved.error }, "local job run cannot be dispatched");
    await failLocalWorkflowRun(run, workflow, resolved.error);
    return null;
  }

  const terminalId = randomUUID();
  const claimed = await db
    .update(workflowRuns)
    .set({ localTerminalId: terminalId, updatedAt: new Date() })
    .where(
      and(
        eq(workflowRuns.id, run.id),
        run.localTerminalId
          ? eq(workflowRuns.localTerminalId, run.localTerminalId)
          : isNull(workflowRuns.localTerminalId),
      ),
    )
    .returning({ id: workflowRuns.id });
  if (claimed.length === 0) {
    log.info("local dispatch lost the claim race — another dispatcher owns this run");
    const [fresh] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    return claimedTerminal(fresh?.localTerminalId);
  }

  try {
    const terminal = await createTerminal({
      id: terminalId,
      host: resolved.host,
      userId: resolved.host.userId,
      workspaceId: workflow.workspaceId ?? resolved.host.workspaceId,
      dir: resolved.dir,
      // A command Job (no agent) runs its already shell-quoted command and exits.
      spec: resolved.agent
        ? {
            kind: "agent",
            agent: resolved.agent,
            prompt: renderedPrompt.trim() || undefined,
            mode: workflow.localSessionMode ?? "headless",
            // The legacy single `model` column, then whatever the job's agent
            // options set for a run on a machine (model, effort, permissions).
            ...(workflow.model ? { model: workflow.model } : {}),
            ...localAgentParams(workflow.agentRuntime, workflow.agentOptions),
          }
        : { kind: "command", command: renderedPrompt },
      title: run.title ?? `${workflow.name} · ${run.id.slice(0, 8)}`,
      spawnedBy: "job",
      modelProviderId: modelProviderIdFrom(workflow.agentOptions),
      workflowRunId: run.id,
      triggerId: run.triggerId ?? undefined,
    });
    log.info({ terminalId: terminal.id, hostId: resolved.host.id }, "local job run dispatched");
    return terminal;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "local job run spawn failed");
    await failLocalWorkflowRun(run, workflow, message);
    return null;
  }
}

/**
 * A dispatch that can't even reach a terminal (misconfiguration, unpaired
 * host) fails the run with the retry budget exhausted: retrying wouldn't
 * change the answer, and the reconciler would otherwise loop on it.
 */
async function failLocalWorkflowRun(
  run: WorkflowRunRow,
  workflow: Workflow,
  message: string,
): Promise<void> {
  const [fresh] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
  const state = (fresh ?? run).state as WorkflowRunState;
  if (state !== WorkflowRunState.QUEUED && state !== WorkflowRunState.RUNNING) return;
  await transitionWorkflowRunCas(run.id, state, WorkflowRunState.FAILED, {
    errorMessage: message,
    finishedAt: new Date(),
    retryCount: Math.max((fresh ?? run).retryCount, workflow.maxRetries),
  });
}

/**
 * Spawn (or re-attach to) the local terminal that executes a queued Repo
 * Task. Called by the task worker instead of provisioning a repo pod. The
 * agent runs in the owner's own checkout: the prompt tells it to branch,
 * commit, push, and open a PR, and the daemon's link scanner promotes the
 * task to `pr_opened` when the PR URL shows up in the output.
 *
 * `resume*` mirror the worker's resume path (auto-resume on CI failure /
 * review feedback): Claude Code and Codex pick their own session back up,
 * other agents start fresh with the resume prompt + original task.
 */
export async function dispatchLocalTask(
  task: TaskRow,
  opts: { resumePrompt?: string; resumeSessionId?: string } = {},
): Promise<LocalTerminalRow | null> {
  const log = logger.child({ taskId: task.id, local: true });
  const existing = await liveTerminal(task.localTerminalId);
  if (existing) return existing;

  const resolved = await resolveLocalHost({
    agentType: task.agentType,
    localHostId: task.localHostId,
    localDir: task.localDir,
    noun: "task",
  });
  if ("error" in resolved) {
    log.warn({ error: resolved.error }, "local task cannot be dispatched");
    await failLocalTask(task, resolved.error);
    return null;
  }

  const terminalId = randomUUID();
  const claimed = await db
    .update(tasks)
    .set({ localTerminalId: terminalId, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.id, task.id),
        task.localTerminalId
          ? eq(tasks.localTerminalId, task.localTerminalId)
          : isNull(tasks.localTerminalId),
      ),
    )
    .returning({ id: tasks.id });
  if (claimed.length === 0) {
    log.info("local dispatch lost the claim race — another dispatcher owns this task");
    const fresh = await taskService.getTask(task.id);
    return claimedTerminal(fresh?.localTerminalId);
  }

  const resumeSessionId =
    opts.resumeSessionId && (resolved.agent === "claude-code" || resolved.agent === "codex")
      ? opts.resumeSessionId
      : undefined;
  const spec: LocalTerminalSpec = {
    kind: "agent",
    // A task always has an agent type, so the host check found its agent.
    agent: resolved.agent!,
    prompt: buildLocalTaskPrompt(task, opts.resumePrompt),
    mode: task.localSessionMode ?? "headless",
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...localAgentParams(task.agentType, (task.metadata as any)?.agentOptions),
  };
  const ticketUrl = (task.metadata as Record<string, unknown> | null)?.ticketUrl;

  try {
    const terminal = await createTerminal({
      id: terminalId,
      host: resolved.host,
      userId: resolved.host.userId,
      workspaceId: task.workspaceId ?? resolved.host.workspaceId,
      dir: resolved.dir,
      spec,
      title: task.title,
      spawnedBy: "task",
      taskId: task.id,
      modelProviderId: modelProviderIdFrom((task.metadata as any)?.agentOptions),
      ticket:
        task.ticketSource && task.ticketExternalId
          ? {
              source: task.ticketSource,
              externalId: task.ticketExternalId,
              url: typeof ticketUrl === "string" ? ticketUrl : undefined,
            }
          : undefined,
    });
    log.info({ terminalId: terminal.id, hostId: resolved.host.id }, "local task dispatched");
    return terminal;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "local task spawn failed");
    await failLocalTask(task, message);
    return null;
  }
}

async function failLocalTask(task: TaskRow, message: string): Promise<void> {
  await taskService.updateTaskResult(task.id, undefined, message);
  await taskService.tryTransitionTask(task.id, TaskState.FAILED, "local_dispatch_failed", message);
}

/**
 * The prompt a local Repo Task hands its agent. The cluster pipeline renders
 * a repo-level template around a task file inside a fresh worktree; a local
 * run works in the owner's existing checkout, so the wrapper is short and
 * self-contained: work on the task branch, open a PR, print its URL.
 */
export function buildLocalTaskPrompt(
  task: Pick<TaskRow, "id" | "title" | "prompt" | "repoUrl" | "repoBranch">,
  resumePrompt?: string,
): string {
  if (resumePrompt) {
    return `${resumePrompt}\n\n---\n\nOriginal task prompt for context:\n${task.prompt}`;
  }
  const parsed = parseRepoUrl(task.repoUrl);
  const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : task.repoUrl;
  const base = task.repoBranch || "main";
  const branch = `${TASK_BRANCH_PREFIX}${task.id}`;
  const gitlab = parsed?.platform === "gitlab";
  const noun = gitlab ? "merge request" : "pull request";
  const cmd = gitlab ? "`glab mr create`" : "`gh pr create`";
  return [
    task.prompt.trim(),
    "",
    "---",
    `This is Optio task ${task.id} ("${task.title}") for ${repoName}, running in a local checkout of the repository.`,
    `Work on a branch, never directly on \`${base}\`: create \`${branch}\` from an up-to-date \`${base}\`, commit your changes there, push it, and open a ${noun} against \`${base}\` (for example with ${cmd}) with a clear title and description.`,
    `If the work needs more than one ${noun}, name each extra branch \`${branch}-<short-slug>\` so Optio tracks every one.`,
    `Print the ${noun} URL when you are done.`,
  ].join("\n");
}

// ── Terminal → run sync (local-terminal-service.notifyChanged) ──────────────

/** Fold the daemon's usage summary into the run's cost columns. */
function usagePatch(terminal: LocalTerminalRow): {
  costUsd?: string;
  inputTokens?: number;
  outputTokens?: number;
  modelUsed?: string;
} | null {
  const u = terminal.usage;
  if (!u) return null;
  return {
    ...(u.costUsd != null ? { costUsd: String(u.costUsd) } : {}),
    inputTokens: Math.round(u.inputTokens),
    outputTokens: Math.round(u.outputTokens),
    ...(u.model ? { modelUsed: u.model } : {}),
  };
}

function usageChanged(
  row: {
    costUsd: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    modelUsed: string | null;
  },
  patch: NonNullable<ReturnType<typeof usagePatch>>,
): boolean {
  return (
    (patch.costUsd !== undefined && patch.costUsd !== row.costUsd) ||
    (patch.inputTokens !== undefined && patch.inputTokens !== row.inputTokens) ||
    (patch.outputTokens !== undefined && patch.outputTokens !== row.outputTokens) ||
    (patch.modelUsed !== undefined && patch.modelUsed !== row.modelUsed)
  );
}

/** Why a dead terminal is dead, for the run's error message. */
function exitMessage(terminal: LocalTerminalRow): string {
  if (terminal.state === "error") return terminal.errorMessage ?? "Local terminal failed to start";
  return terminal.errorMessage ?? `Agent exited with code ${terminal.exitCode ?? "unknown"}`;
}

async function maxRetriesOf(workflowId: string): Promise<number> {
  const [wf] = await db
    .select({ maxRetries: workDefinitions.maxRetries })
    .from(workDefinitions)
    .where(eq(workDefinitions.id, workflowId));
  return wf?.maxRetries ?? 0;
}

/**
 * How a session someone killed ends its run. Closing an interactive session
 * is how its run finishes, so that's a success whatever the exit code the
 * kill caused; killing a headless run mid-flight stops it, and nothing
 * retries a run you stopped. Null when the terminal wasn't killed.
 */
function killedOutcome(terminal: LocalTerminalRow): "finished" | "stopped" | null {
  if (terminal.attentionReason !== KILLED_REASON) return null;
  const spec = terminal.spec as unknown as LocalTerminalSpec;
  return spec.kind === "agent" && spec.mode === "headless" ? "stopped" : "finished";
}

/**
 * Called after every terminal update. Maps the terminal's state onto the
 * Job run / Repo Task it executes. Safe to call repeatedly; a terminal that
 * is no longer the run's current attempt (a retry replaced it) is ignored.
 */
export async function syncLinkedRun(terminal: LocalTerminalRow): Promise<void> {
  if (terminal.workflowRunId) await syncWorkflowRun(terminal);
  if (terminal.taskId) await syncTask(terminal);
}

async function syncWorkflowRun(terminal: LocalTerminalRow): Promise<void> {
  const runId = terminal.workflowRunId!;
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  if (!run) return;
  if (run.localTerminalId && run.localTerminalId !== terminal.id) return;
  const usage = usagePatch(terminal);
  const state = run.state as WorkflowRunState;

  switch (terminal.state) {
    case "pending":
      return;
    case "launching":
    case "running": {
      if (state === WorkflowRunState.QUEUED) {
        await transitionWorkflowRunCas(runId, WorkflowRunState.QUEUED, WorkflowRunState.RUNNING, {
          startedAt: terminal.startedAt ?? new Date(),
          ...(usage ?? {}),
        });
        return;
      }
      if (state === WorkflowRunState.RUNNING && usage && usageChanged(run, usage)) {
        // Live cost while the session runs. No updatedAt bump: this is not a
        // state change and must not invalidate an in-flight reconcile.
        await db.update(workflowRuns).set(usage).where(eq(workflowRuns.id, runId));
      }
      return;
    }
    case "exited":
    case "error": {
      if (state !== WorkflowRunState.QUEUED && state !== WorkflowRunState.RUNNING) return;
      const killed = killedOutcome(terminal);
      const ok = killed === "finished" || (terminal.state === "exited" && terminal.exitCode === 0);
      // A stopped run is a cancel: no retry budget left, like cancelWorkflowRun.
      const stopped =
        killed === "stopped"
          ? {
              errorMessage: "Stopped by user",
              retryCount: Math.max(run.retryCount ?? 0, await maxRetriesOf(run.workflowId)),
            }
          : {};
      const fields = {
        finishedAt: terminal.endedAt ?? new Date(),
        errorMessage: ok ? null : exitMessage(terminal),
        ...stopped,
        output: {
          ...(terminal.preview ? { summary: terminal.preview } : {}),
          ...(terminal.agentSessionId ? { agentSessionId: terminal.agentSessionId } : {}),
          ...(terminal.links?.length ? { links: terminal.links } : {}),
        },
        ...(usage ?? {}),
      };
      if (state === WorkflowRunState.QUEUED) {
        // Never observed launching (a spawn error while pending, or frames
        // collapsed by a daemon restart). Failure is valid from queued;
        // success has to pass through running.
        if (!ok) {
          await transitionWorkflowRunCas(
            runId,
            WorkflowRunState.QUEUED,
            WorkflowRunState.FAILED,
            fields,
          );
          return;
        }
        await transitionWorkflowRunCas(runId, WorkflowRunState.QUEUED, WorkflowRunState.RUNNING, {
          startedAt: terminal.startedAt ?? new Date(),
        });
      }
      await transitionWorkflowRunCas(
        runId,
        WorkflowRunState.RUNNING,
        ok ? WorkflowRunState.COMPLETED : WorkflowRunState.FAILED,
        fields,
      );
      return;
    }
  }
}

/**
 * The PRs a local Repo Task's agent created, from the terminal's transcript:
 * PR-creating tool calls (`gh pr create`, MCP `create_pull_request`, …)
 * paired with their own results. Links the agent merely printed are not
 * evidence (they still show as the terminal's links).
 */
export async function localTaskPrMatches(
  terminalId: string,
  toolUseIds?: string[],
): Promise<PrToolCallMatch[]> {
  const kinds = inArray(localTerminalTranscripts.kind, ["tool_use", "tool_result"]);
  const rows = await db
    .select({
      kind: localTerminalTranscripts.kind,
      text: localTerminalTranscripts.text,
      detail: localTerminalTranscripts.detail,
      toolName: localTerminalTranscripts.toolName,
      toolUseId: localTerminalTranscripts.toolUseId,
      isError: localTerminalTranscripts.isError,
    })
    .from(localTerminalTranscripts)
    .where(
      and(
        eq(localTerminalTranscripts.terminalId, terminalId),
        kinds,
        toolUseIds
          ? inArray(localTerminalTranscripts.toolUseId, toolUseIds)
          : isNotNull(localTerminalTranscripts.toolUseId),
      ),
    )
    .orderBy(asc(localTerminalTranscripts.seq));
  return prsFromTranscript(rows);
}

/**
 * Find and adopt a local task's PRs: its transcript's PR-creating calls
 * (confirmed on the git platform) and open PRs on branches under the task's
 * branch. Returns the task's primary PR URL afterwards.
 */
async function detectLocalTaskPrs(
  task: Pick<TaskRow, "id" | "repoUrl">,
  terminal: LocalTerminalRow,
  toolUseIds?: string[],
): Promise<string | null> {
  try {
    const matches = await localTaskPrMatches(terminal.id, toolUseIds);
    // Mid-run (a transcript batch) only the calls matter; at exit also ask
    // the platform for PRs on the task's branches.
    if (toolUseIds && matches.length === 0) return null;
    const { primaryUrl } = await detectTaskPrs(
      { id: task.id, repoUrl: task.repoUrl },
      { matches, runStartedAt: terminal.startedAt ?? terminal.createdAt ?? null },
    );
    return primaryUrl;
  } catch (err) {
    logger.warn({ err, taskId: task.id, terminalId: terminal.id }, "local: PR detection failed");
    return null;
  }
}

/**
 * New transcript entries for a terminal running a Repo Task: when they hold
 * the result of a PR-creating call, adopt the PR and move a running task to
 * pr_opened. Called by local-terminal-service after it stores a batch.
 */
export async function onTaskTranscript(
  terminal: LocalTerminalRow,
  entries: { kind: string; toolUseId: string | null }[],
): Promise<void> {
  if (!terminal.taskId) return;
  const ids = [
    ...new Set(
      entries.filter((e) => e.kind === "tool_result" && e.toolUseId).map((e) => e.toolUseId!),
    ),
  ];
  if (ids.length === 0) return;
  const task = await taskService.getTask(terminal.taskId);
  if (!task || task.prUrl) return;
  if (task.localTerminalId && task.localTerminalId !== terminal.id) return;
  const prUrl = await detectLocalTaskPrs(task, terminal, ids);
  if (!prUrl || task.state !== TaskState.RUNNING) return;
  await taskService.tryTransitionTask(
    task.id,
    TaskState.PR_OPENED,
    "pr_detected",
    `PR opened in the local session: ${prUrl}`,
  );
}

async function syncTask(terminal: LocalTerminalRow): Promise<void> {
  const task = await taskService.getTask(terminal.taskId!);
  if (!task) return;
  if (task.localTerminalId && task.localTerminalId !== terminal.id) return;

  // The agent's own session id doubles as the task's resume handle.
  if (terminal.agentSessionId && task.sessionId !== terminal.agentSessionId) {
    await taskService.updateTaskSession(task.id, terminal.agentSessionId);
  }
  const usage = usagePatch(terminal);
  if (usage && usageChanged(task, usage)) {
    await db.update(tasks).set(usage).where(eq(tasks.id, task.id));
  }

  const step = async (to: TaskState, trigger: string, message?: string): Promise<boolean> =>
    (await taskService.tryTransitionTask(task.id, to, trigger, message)) != null;
  // Reach RUNNING from wherever the task is (the state machine has no
  // shortcut from queued to running / pr_opened).
  const climbToRunning = async (from: TaskState): Promise<boolean> => {
    if (from === TaskState.QUEUED && !(await step(TaskState.PROVISIONING, "local_spawn"))) {
      return false;
    }
    if (from === TaskState.QUEUED || from === TaskState.PROVISIONING) {
      return step(TaskState.RUNNING, "local_started");
    }
    return from === TaskState.RUNNING;
  };
  const state = task.state as TaskState;

  switch (terminal.state) {
    case "pending":
      return;
    case "launching":
      if (state === TaskState.QUEUED) await step(TaskState.PROVISIONING, "local_spawn");
      return;
    case "running": {
      if (state === TaskState.QUEUED || state === TaskState.PROVISIONING) {
        await climbToRunning(state);
      }
      // PRs are adopted from the transcript as the agent creates them
      // (onTaskTranscript), which moves a running task to pr_opened.
      return;
    }
    case "exited":
    case "error": {
      if (
        state !== TaskState.QUEUED &&
        state !== TaskState.PROVISIONING &&
        state !== TaskState.RUNNING
      ) {
        return; // pr_opened / cancelled / already terminal: the exit changes nothing
      }
      const prUrl = task.prUrl ?? (await detectLocalTaskPrs(task, terminal));
      const killed = killedOutcome(terminal);
      const ok = terminal.state === "exited" && terminal.exitCode === 0;
      if (prUrl) {
        // A PR exists: the task is waiting on CI / review, whatever the exit
        // code — the agent may exit non-zero after opening a valid PR.
        if (!task.prUrl) await taskService.updateTaskPr(task.id, prUrl);
        if (await climbToRunning(state)) {
          await step(
            TaskState.PR_OPENED,
            "pr_detected",
            `PR opened in the local session: ${prUrl}`,
          );
        }
        return;
      }
      if (ok || killed === "finished") {
        if (await climbToRunning(state)) {
          await step(
            TaskState.COMPLETED,
            "local_exit",
            ok ? "Agent finished (exit 0) without a PR" : "Session closed without a PR",
          );
        }
        return;
      }
      if (killed === "stopped") {
        // Cancelled, not failed: a failed task would be retried.
        if (state === TaskState.PROVISIONING && !(await climbToRunning(state))) return;
        await step(TaskState.CANCELLED, "local_killed", "Stopped by user");
        return;
      }
      const message = exitMessage(terminal);
      await taskService.updateTaskResult(task.id, undefined, message);
      await step(TaskState.FAILED, "local_exit", message);
      return;
    }
  }
}

// ── Cancellation ─────────────────────────────────────────────────────────────

/**
 * Stop the terminal behind a run that was cancelled or failed from the
 * server side (cancel button, reconciler intent, dependency failure). No-op
 * when the terminal is already dead. Best-effort: the run's own state was
 * already written by the caller.
 */
export async function killLinkedTerminal(
  terminalId: string | null | undefined,
  reason: string,
): Promise<void> {
  if (!terminalId) return;
  const terminal = await getTerminal(terminalId);
  if (!terminal || !isLiveTerminalState(terminal.state)) return;
  logger.info({ terminalId, reason }, "local: killing terminal behind a finished run");
  await killTerminal(terminal).catch((err) =>
    logger.warn({ err, terminalId }, "local: failed to kill terminal for finished run"),
  );
}
