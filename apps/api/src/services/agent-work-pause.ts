import { and, eq, inArray, sql } from "drizzle-orm";
import {
  PersistentAgentState,
  PrReviewRunState,
  PrReviewState,
  TaskState,
  WorkflowRunState,
} from "@optio/shared";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  localTerminals,
  persistentAgents,
  prReviewRuns,
  tasks,
  users,
  workflowRuns,
} from "../db/schema.js";
import { logger } from "../logger.js";
import { getDeploymentSetting, setDeploymentSetting } from "./deployment-settings.js";

/**
 * Pausing all agent work (docs/pausing-agent-work.md): a deployment admin's
 * switch for an incident or an upgrade. Off unless one turns it on.
 *
 * While paused, nothing new starts anywhere in the deployment:
 *
 * - Queued Tasks, Job runs, agent turns and review runs are **held** where
 *   they are, with the reason as their message, at the same admission check
 *   as usage budgets (usage-budget-service.ts). Workers re-check them every
 *   minute and lifting the pause wakes them at once (`releaseHeldWork`).
 * - Trigger occurrences (webhooks, tickets, events) stay pending in Postgres
 *   (trigger-delivery.ts), and the schedule sweep skips, so each due schedule
 *   fires once when the pause lifts: nothing is lost and nothing piles up.
 * - Queued session messages wait; a new session message, a Local terminal
 *   start and every interactive start (`START_ROUTES`) are refused with the
 *   reason.
 *
 * Work already running carries on. "Stop everything" (`stopAllAgentWork`)
 * also cancels that, in every workspace, through each kind's own cancel path.
 *
 * Stored as one `deployment_settings` row, read on every check (no cache), so
 * every API and worker replica sees it at once and it survives restarts.
 */

export const AGENT_WORK_PAUSE_KEY = "agentWork.paused";

/** The start of every message for work held or refused by the pause. */
export const PAUSE_MESSAGE_PREFIX = "Agent work is paused by an administrator";

export const PAUSE_REASON_MAX = 500;

export interface AgentWorkPause {
  reason: string;
  /** ISO time the pause began. */
  pausedAt: string;
  /** Who paused it (null when auth is disabled). */
  pausedBy: string | null;
  /** Set by "Stop everything": work caught mid-setup is cancelled, not held. */
  stopped: boolean;
}

function isPause(v: unknown): v is AgentWorkPause {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as AgentWorkPause).reason === "string" &&
    typeof (v as AgentWorkPause).pausedAt === "string"
  );
}

/** The pause in force, or null. */
export async function getAgentWorkPause(): Promise<AgentWorkPause | null> {
  const stored = await getDeploymentSetting(AGENT_WORK_PAUSE_KEY);
  return isPause(stored) ? { ...stored, stopped: stored.stopped === true } : null;
}

export function pauseMessage(pause: Pick<AgentWorkPause, "reason">): string {
  return `${PAUSE_MESSAGE_PREFIX}: ${pause.reason}`;
}

/** Why new agent work can't start now, or null when it can. */
export async function agentWorkPauseHold(): Promise<string | null> {
  const pause = await getAgentWorkPause();
  return pause ? pauseMessage(pause) : null;
}

/** Turn the pause on (or change its reason). */
export async function pauseAgentWork(
  reason: string,
  userId: string | null,
  opts: { stopped?: boolean } = {},
): Promise<AgentWorkPause> {
  const pause: AgentWorkPause = {
    reason: reason.trim().slice(0, PAUSE_REASON_MAX),
    pausedAt: new Date().toISOString(),
    pausedBy: userId,
    stopped: opts.stopped === true,
  };
  await setDeploymentSetting(AGENT_WORK_PAUSE_KEY, pause, userId);
  logger.warn({ pausedBy: userId, stopped: pause.stopped }, "Agent work paused");
  return pause;
}

/** Lift the pause and let held work go. Returns whether one was in force. */
export async function resumeAgentWork(userId: string | null): Promise<boolean> {
  const was = await getAgentWorkPause();
  await setDeploymentSetting(AGENT_WORK_PAUSE_KEY, null, userId);
  if (was) logger.warn({ resumedBy: userId }, "Agent work resumed");
  await releaseHeldWork();
  return !!was;
}

/**
 * Wake work the admission check held (its delayed `-budget-` retry jobs) so
 * it starts now instead of at its next check, and deliver the trigger
 * occurrences that waited. Work still over a usage budget is simply held
 * again. Best effort: anything missed starts at its next check anyway.
 */
export async function releaseHeldWork(): Promise<number> {
  let woken = 0;
  const queues = await Promise.all([
    import("../workers/task-worker.js").then((m) => m.taskQueue),
    import("../workers/workflow-worker.js").then((m) => m.workflowRunQueue),
    import("../workers/pr-review-worker.js").then((m) => m.prReviewRunQueue),
    import("../workers/persistent-agent-worker.js").then((m) => m.persistentAgentTurnQueue),
  ]);
  for (const queue of queues) {
    try {
      const delayed = await queue.getDelayed();
      for (const job of delayed) {
        if (!job.id?.includes("-budget-")) continue;
        await job
          .promote()
          .then(() => woken++)
          .catch(() => {});
      }
    } catch (err) {
      logger.warn({ err, queue: queue.name }, "Could not wake held work");
    }
  }
  const { drainTriggerDeliveries } = await import("./trigger-delivery.js");
  await drainTriggerDeliveries().catch((err) =>
    logger.warn({ err }, "Could not deliver held trigger occurrences"),
  );
  return woken;
}

export interface StopCounts {
  tasks: number;
  jobRuns: number;
  reviews: number;
  agents: number;
  sessions: number;
  terminals: number;
  /** Runs a cancel didn't land on (they finished meanwhile, or the path refused). */
  skipped: number;
}

/**
 * "Stop everything": pause, then cancel every queued or running agent run in
 * every workspace through its own cancel path, so its state, pod and slot are
 * cleaned up as a person's cancel would.
 */
export async function stopAllAgentWork(
  reason: string,
  userId: string | null,
): Promise<{ pause: AgentWorkPause; cancelled: StopCounts }> {
  // Pause first: nothing new starts while the sweep below runs.
  const pause = await pauseAgentWork(reason, userId, { stopped: true });
  const message = pauseMessage(pause);
  const counts: StopCounts = {
    tasks: 0,
    jobRuns: 0,
    reviews: 0,
    agents: 0,
    sessions: 0,
    terminals: 0,
    skipped: 0,
  };
  const attempt = async (
    key: Exclude<keyof StopCounts, "skipped">,
    run: () => Promise<unknown>,
  ) => {
    try {
      const done = await run();
      if (done === false || done === null) counts.skipped++;
      else counts[key]++;
    } catch (err) {
      counts.skipped++;
      logger.warn({ err, kind: key }, "Stop everything: a cancel did not land");
    }
  };

  // Tasks (Repo Tasks and standalone ones). A task setting up its pod can't be
  // cancelled mid-setup; the worker cancels it before its agent starts
  // (task-worker.ts, `stopped` above).
  const taskService = await import("./task-service.js");
  const activeTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(inArray(tasks.state, [TaskState.WAITING_ON_DEPS, TaskState.QUEUED, TaskState.RUNNING]));
  for (const t of activeTasks)
    await attempt("tasks", () =>
      taskService.transitionTask(
        t.id,
        TaskState.CANCELLED,
        "agent_work_stopped",
        message,
        userId ?? undefined,
      ),
    );

  // Job runs.
  const workflowService = await import("./workflow-service.js");
  const activeRuns = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(inArray(workflowRuns.state, [WorkflowRunState.QUEUED, WorkflowRunState.RUNNING]));
  for (const r of activeRuns)
    await attempt("jobRuns", () => workflowService.cancelWorkflowRun(r.id));

  // PR reviews with a run queued, setting up or running: cancelling the review
  // cancels and stops its runs (pr-review-service.ts `transitionPrReview`).
  const prReviewService = await import("./pr-review-service.js");
  const activeReviews = await db
    .selectDistinct({ id: prReviewRuns.prReviewId })
    .from(prReviewRuns)
    .where(
      inArray(prReviewRuns.state, [
        PrReviewRunState.QUEUED,
        PrReviewRunState.PROVISIONING,
        PrReviewRunState.RUNNING,
      ]),
    );
  for (const r of activeReviews)
    await attempt("reviews", () =>
      prReviewService.transitionPrReview(r.id, PrReviewState.CANCELLED, "agent_work_stopped", {
        message,
        userId: userId ?? undefined,
      }),
    );

  // Persistent agents with a turn queued or going: paused (their owner resumes
  // them), and the agent of any open turn signalled to stop.
  const paService = await import("./persistent-agent-service.js");
  const { enqueueReconcile } = await import("./reconcile-queue.js");
  const activeAgents = await db
    .select({ id: persistentAgents.id, workspaceId: persistentAgents.workspaceId })
    .from(persistentAgents)
    .where(
      inArray(persistentAgents.state, [
        PersistentAgentState.QUEUED,
        PersistentAgentState.PROVISIONING,
        PersistentAgentState.RUNNING,
      ]),
    );
  for (const a of activeAgents)
    await attempt("agents", async () => {
      const row = await paService.setControlIntent(a.id, "pause", a.workspaceId);
      if (!row) return false;
      await paService.stopOpenTurns(a.id);
      await enqueueReconcile(
        { kind: "persistent-agent", id: a.id },
        { reason: "agent_work_stopped" },
      ).catch(() => {});
      return true;
    });

  // Interactive sessions: ended, which interrupts their turn and removes the pod.
  const sessionService = await import("./interactive-session-service.js");
  const activeSessions = await db
    .select({ id: interactiveSessions.id })
    .from(interactiveSessions)
    .where(eq(interactiveSessions.state, "active"));
  for (const s of activeSessions) await attempt("sessions", () => sessionService.endSession(s.id));

  // Optio Local agent terminals not already stopped with their Task or Job run.
  const terminalService = await import("./local-terminal-service.js");
  const activeTerminals = await db
    .select()
    .from(localTerminals)
    .where(
      and(
        inArray(localTerminals.state, ["pending", "launching", "running"]),
        sql`${localTerminals.spec}->>'kind' = 'agent'`,
      ),
    );
  for (const t of activeTerminals)
    await attempt("terminals", () => terminalService.killTerminal(t));

  logger.warn({ stoppedBy: userId, ...counts }, "Stopped all agent work");
  return { pause, cancelled: counts };
}

/** Who paused, for the banner and the settings card. */
export async function pauserName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return row ? row.displayName || row.email : null;
}

/**
 * The interactive starts refused while paused, as "METHOD /url" (the route's
 * pattern). Work started by a schedule, trigger, retry or the reconciler is
 * held instead (see above). routes/agent-work.test.ts checks each one exists.
 */
export const START_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/tasks",
  "POST /api/tasks/:id/retry",
  "POST /api/tasks/:id/force-redo",
  "POST /api/tasks/:id/review",
  "POST /api/tasks/:id/run-now",
  "POST /api/tasks/:id/resume",
  "POST /api/tasks/:id/force-restart",
  "POST /api/tasks/:id/subtasks",
  "POST /api/tasks/:id/runs",
  "POST /api/tasks/bulk/retry-failed",
  "POST /api/work",
  "POST /api/jobs/:id/runs",
  "POST /api/workflow-runs/:id/retry",
  "POST /api/sessions",
  "POST /api/pr-reviews",
  "POST /api/pr-reviews/:id/re-review",
  "POST /api/pr-reviews/:id/chat",
  "POST /api/persistent-agents/:id/messages",
  "POST /api/issues/assign",
  "POST /api/local/terminals",
  "POST /api/local/terminals/:id/start",
  "POST /api/local/terminals/:id/resume",
  "POST /api/local/blueprints/:id/spawn",
]);
