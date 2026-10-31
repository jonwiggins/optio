import { and, desc, eq } from "drizzle-orm";
import { parsePrUrl, parseRepoUrl } from "@optio/shared";
import { db } from "../../db/client.js";
import { gitlabMentions, taskEvents, tasks } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { outcomeReply, publicReason, publicWebUrl } from "./replies.js";
import { mentionPlatform, mentionThread } from "./thread.js";
import { wordsFor } from "./words.js";

/**
 * The result of work an @-mention started or resumed goes back to the
 * comment's thread, once (docs/gitlab-bot.md): the merge request it opened
 * or pushed to, the reason it needs a person, why it failed, or that it was
 * cancelled. task-service.ts `announceTransition` calls
 * `onMentionedTaskTransition` after every committed transition; the claim
 * (`started` → `done`) makes it once per comment however many instances
 * see the transition.
 *
 * A run that moved on again before this read (an automatic resume puts a
 * task through needs_attention to queued) isn't reported: its next end is.
 */

const OUTCOMES = ["pr_opened", "completed", "needs_attention", "failed", "cancelled"] as const;
type Outcome = (typeof OUTCOMES)[number];
const isOutcome = (s: string): s is Outcome => (OUTCOMES as readonly string[]).includes(s);

/** The same merge request, whichever way its URL is written. */
function sameMergeRequest(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const pa = parsePrUrl(a);
  const pb = parsePrUrl(b);
  if (!pa || !pb) return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  return (
    pa.host === pb.host &&
    `${pa.owner}/${pa.repo}`.toLowerCase() === `${pb.owner}/${pb.repo}`.toLowerCase() &&
    pa.prNumber === pb.prNumber
  );
}

export async function onMentionedTaskTransition(taskId: string, toState: string): Promise<void> {
  if (!isOutcome(toState)) return;
  const open = await db
    .select({ id: gitlabMentions.id })
    .from(gitlabMentions)
    .where(and(eq(gitlabMentions.taskId, taskId), eq(gitlabMentions.status, "started")));
  if (open.length === 0) return;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || !isOutcome(task.state)) return;
  const state = task.state;
  // What made it wait or fail, for words a public thread may read (publicReason).
  let trigger: string | null = null;
  if (state === "needs_attention" || state === "failed") {
    const [ev] = await db
      .select({ trigger: taskEvents.trigger })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.toState, state)))
      .orderBy(desc(taskEvents.createdAt))
      .limit(1);
    trigger = ev?.trigger ?? null;
  }

  for (const { id } of open) {
    const [row] = await db
      .update(gitlabMentions)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(gitlabMentions.id, id), eq(gitlabMentions.status, "started")))
      .returning();
    if (!row) continue;
    try {
      const platform = mentionPlatform(row);
      const ri = parseRepoUrl(row.projectUrl, platform === "github" ? "github" : undefined);
      if (!ri) continue;
      const body = outcomeReply({
        author: row.authorUsername,
        state,
        taskId,
        base: publicWebUrl(),
        prUrl: task.prUrl,
        sameMr:
          row.noteableType === "MergeRequest" &&
          (sameMergeRequest(task.prUrl, row.subject?.url) ||
            (!!task.prNumber &&
              task.prNumber === row.noteableIid &&
              !!task.prUrl &&
              parsePrUrl(task.prUrl)?.host === ri.host)),
        reason: publicReason(trigger, task.errorMessage, wordsFor(platform)),
        words: wordsFor(platform),
      });
      const thread = await mentionThread(ri, row.workspaceId);
      await thread.reply(row, body);
      await db
        .update(gitlabMentions)
        .set({ repliedAt: new Date() })
        .where(eq(gitlabMentions.id, row.id));
    } catch (err) {
      logger.warn(
        { err, mentionId: row.id, taskId },
        "Mention: could not post the run's result in the thread",
      );
    }
  }
}
