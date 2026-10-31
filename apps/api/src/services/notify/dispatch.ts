import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { workDefinitions, workRuns } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { anyChatHook } from "./chat-hooks.js";
import { workChatMessage } from "./chat-messages.js";
import { emailAvailable } from "./email.js";
import { prepareFanout, reachPerson } from "./fanout.js";
import { workRecipients } from "./recipients.js";
import { renderWorkEmail, type WorkSummary } from "./templates.js";

/**
 * Work events → email, each person's own chat hook, and the team's channel
 * for a team's work (fanout.ts). Called once per committed transition, from the
 * instance that made it: a Task's through `notification-service.ts`
 * (`sendPushNotificationForTransition`), a Job run's from
 * `workflow-service.ts` (`announceWorkflowRunTransition`). Fire and forget —
 * nothing here throws to the caller, and nothing runs when neither a relay
 * nor any chat hook is set.
 *
 *   pr_opened        → task.pr_opened        "Merge request waiting for you"
 *   needs_attention  → task.needs_attention
 *   failed           → task.failed           (a Task, or a Job run's last failure)
 *   completed        → task.completed        (only when its MR was merged)
 */

const STATE_TO_KIND: Record<string, string> = {
  pr_opened: "task.pr_opened",
  needs_attention: "task.needs_attention",
  failed: "task.failed",
  completed: "task.completed",
};

export interface WorkEventOutcome {
  kind: string | null;
  sent: string[];
  skipped: Array<{ userId: string; why: string }>;
  /** Of `sent`, those whose own chat hook got it (absent when none). */
  chat?: string[];
}

const none = (kind: string | null = null): WorkEventOutcome => ({ kind, sent: [], skipped: [] });

/** The work row an event is about, as the email needs it, or null. */
async function loadWork(runId: string) {
  const [row] = await db
    .select({
      id: workRuns.id,
      kind: workRuns.kind,
      title: workRuns.title,
      repoUrl: workRuns.repoUrl,
      prUrl: workRuns.prUrl,
      prState: workRuns.prState,
      errorMessage: workRuns.errorMessage,
      taskType: workRuns.taskType,
      workId: workRuns.workId,
      workspaceId: workRuns.workspaceId,
      ownerUserId: workRuns.ownerUserId,
      createdBy: workRuns.createdBy,
      // Whether a Job run's failure is its last word (jobFailureNotNews).
      state: workRuns.state,
      retryCount: workRuns.retryCount,
      recoveryRequired: workRuns.recoveryRequired,
      // A Job run's title is often empty: its Job's name says what it is.
      workName: workDefinitions.name,
      maxRetries: workDefinitions.maxRetries,
    })
    .from(workRuns)
    .leftJoin(workDefinitions, eq(workDefinitions.id, workRuns.workId))
    .where(eq(workRuns.id, runId));
  return row ?? null;
}

/** How a person's cancel of a Job run is stored: as a failure with this message. */
export const JOB_RUN_CANCELLED = "Cancelled by user";

/**
 * Why a failed Job run is not news (yet), or null when this failure is its
 * last word. A cancel is stored as a failure ("Cancelled by user":
 * workflow-service.ts `cancelWorkflowRun`, the reconciler's cancel intent),
 * and the reconciler sends a failed run back to the queue while it has
 * retries left (`decideFailed` in packages/shared reconcile-standalone.ts:
 * retryCount below the Job's maxRetries, unless recoveryRequired holds it
 * for a person). Tasks need none of this: a cancel is `cancelled`, and a
 * failed Task isn't retried by itself.
 */
export function jobFailureNotNews(run: {
  state: string;
  errorMessage: string | null;
  retryCount: number;
  recoveryRequired: boolean;
  maxRetries: number | null;
}): string | null {
  if (run.state !== "failed") return "no longer failed";
  if (run.errorMessage === JOB_RUN_CANCELLED) return "cancelled by a person";
  if (!run.recoveryRequired && run.retryCount < (run.maxRetries ?? 0)) return "will be retried";
  return null;
}

/**
 * Email the people who should hear that run `runId` reached `toState`.
 * Resolves what happened (for tests and logs).
 */
export async function notifyWorkEvent(runId: string, toState: string): Promise<WorkEventOutcome> {
  const kind = STATE_TO_KIND[toState] ?? null;
  if (!kind) return none();
  const emailOn = await emailAvailable();
  const chatOn = await anyChatHook().catch(() => false);
  if (!emailOn && !chatOn) return none(kind);
  const work = await loadWork(runId);
  if (!work) return none(kind);
  // A code-review subtask's state is its parent's business.
  if (work.taskType === "review") return none(kind);
  // A Job run has no merge request: only its failure is news, and only the
  // last one — not an attempt the reconciler retries, nor a person's cancel.
  if (work.kind === "standalone") {
    if (kind !== "task.failed") return none(kind);
    const why = jobFailureNotNews(work);
    if (why) {
      logger.debug({ runId, why }, "notify: Job run failure not emailed");
      return none(kind);
    }
  }
  // "Merged" means merged: a Task that completed without an MR says nothing.
  if (
    kind === "task.completed" &&
    !(work.prState === "merged" || (work.prUrl && work.prState !== "closed"))
  ) {
    return none(kind);
  }

  const recipients = await workRecipients(work);
  const fan = await prepareFanout(
    recipients.map((r) => r.userId),
    { emailOn, chatOn },
  );
  const outcome: WorkEventOutcome = { kind, sent: [], skipped: [] };
  const chat: string[] = [];
  const summary: WorkSummary = {
    id: work.id,
    kind: work.kind,
    title: work.title || work.workName || "",
    repoUrl: work.kind === "repo" ? work.repoUrl : null,
    prUrl: work.prUrl,
    errorMessage: work.errorMessage,
    workId: work.workId,
  };
  const chatMessage = workChatMessage(kind, summary);
  for (const r of recipients) {
    const result = await reachPerson(
      r,
      kind,
      fan,
      {
        email: () => {
          const email = renderWorkEmail(kind, summary, r.reason);
          return {
            to: [],
            subject: email.subject,
            text: email.text,
            headers: { "X-Optio-Event": kind, "X-Optio-Work": summary.id },
          };
        },
        chat: () => chatMessage,
      },
      work.workspaceId,
    );
    if (result.reached) {
      outcome.sent.push(r.userId);
      if (result.chat) chat.push(r.userId);
    } else {
      outcome.skipped.push({ userId: r.userId, why: result.why ?? "not sent" });
    }
  }
  if (chat.length) outcome.chat = chat;
  if (outcome.sent.length || outcome.skipped.length) {
    logger.info(
      {
        runId,
        kind,
        sent: outcome.sent.length,
        chat: chat.length,
        skipped: outcome.skipped.length,
      },
      "notify: work event sent",
    );
  }
  return outcome;
}

/** The hook's form: never rejects. */
export async function onWorkTransition(runId: string, toState: string): Promise<void> {
  try {
    await notifyWorkEvent(runId, toState);
  } catch (err) {
    logger.warn({ err, runId, toState }, "notify: work event not emailed");
  }
}
