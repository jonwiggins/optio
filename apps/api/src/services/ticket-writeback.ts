/**
 * The ticket round trip's writing half (docs/ticket-round-trip.md): a ticket
 * hears how the work it became is going.
 *
 *   work started      a comment with a link to the run; status → mapping.started;
 *                     the work's link `optio:<task id>` (to the run)
 *   MR opened         a comment with the MR's link; status → mapping.mrOpened;
 *                     the work's link now points at the MR
 *   MR updated        after a follow-up from a ticket comment: a comment with the MR
 *   merged            a comment; status → mapping.merged; the link marked resolved
 *   failed            a comment with the kind of failure; status → mapping.failed
 *   needs a person    a comment with what it waits for (sent only if the work
 *                     still waits a minute later: an automatic resume passes through it)
 *   skipped ticket    one comment: no repository matches the ticket (none for
 *                     the backlog a provider's first sweep finds)
 *
 * Nothing happens until the provider's round trip is switched on; then which
 * of these it does is its round-trip settings (`config.roundTrip`,
 * @optio/shared ticket-round-trip.ts; Settings → Integrations → Tickets) and
 * what its service supports: the calls are the service's TicketRoundTrip
 * (@optio/ticket-providers: GitHub, GitLab, Jira, Linear, Notion), and the
 * work's link is a Jira remote link, a GitHub / GitLab comment edited in
 * place (`link_id`) or a Linear attachment. Every event is one `ticket_writebacks` row with a
 * key that makes it happen once however often it is announced
 * (`<task id>:started`, `<task id>:mr_opened:<MR url>`, …); `done_steps`
 * keeps a retry from repeating a comment that went through. A step that
 * fails leaves the row `failed`, and the ticket sync retries it
 * (`retryTicketWritebacks`, with a growing wait, for a day); a step of an
 * event about the work's state is left out once a newer event of the work
 * did that step, so a late retry never moves the ticket back, relabels the
 * link or comments out of order. A reason on the ticket is the
 * trigger's words or the error's class (`publicReason`), never the error
 * itself: the ticket's readers aren't the work's. The comments Optio
 * posts are kept (`comment_id`, `link_id`): the follow-up poll never reads
 * them as instructions (ticket-follow-ups.ts).
 *
 * The hook: task-service.ts `announceTransition` calls
 * `onTicketWorkTransition` once per committed transition of work from a
 * ticket. Nothing here throws to the caller.
 */
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  ROUND_TRIP_STEPS,
  TaskState,
  classifyError,
  roundTripSettings,
  roundTripSupport,
  type RoundTripStep,
  type Ticket,
  type TicketRoundTripSettings,
} from "@optio/shared";
import {
  getTicketRoundTrip,
  gitLabRoundTripConfig,
  type CommentPart,
} from "@optio/ticket-providers";
import { db } from "../db/client.js";
import { tasks, ticketProviders, ticketWritebacks } from "../db/schema.js";
import { logger } from "../logger.js";
import { absoluteLink } from "./notify/templates.js";
import { roundTripMarks } from "./ticket-round-trip-marks.js";
import { runUrlOf } from "./work-traceability.js";

export type WritebackEvent =
  | "started"
  | "mr_opened"
  | "mr_updated"
  | "merged"
  | "failed"
  | "needs_attention"
  | "follow_up"
  | "follow_up_limit"
  | "skipped";

type Step = "comment" | "transition" | "link";

/** Which mapping a status move takes its target from. */
const STEP_OF: Partial<Record<WritebackEvent, RoundTripStep>> = {
  started: "started",
  mr_opened: "mrOpened",
  merged: "merged",
  failed: "failed",
};

/**
 * The work's own events (not a follow-up's acknowledgement): each says where
 * the work is now, and leaves the remote link saying so. A newer one that
 * did a step makes that step of an older one out of date (`newerStepSent`).
 */
const LINKED: ReadonlySet<WritebackEvent> = new Set([
  "started",
  "mr_opened",
  "mr_updated",
  "merged",
  "failed",
  "needs_attention",
]);

/** How long a "needs a person" waits before it is sent (an automatic resume passes through it). */
export const ATTENTION_GRACE_MS = 45_000;
/** Attempts before a row is given up; the wait between them grows (attempts² minutes). */
export const MAX_ATTEMPTS = 8;

type WritebackRow = typeof ticketWritebacks.$inferSelect;
type ProviderRow = typeof ticketProviders.$inferSelect;

/** The task columns the round trip reads. */
async function loadTask(taskId: string) {
  const [row] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      state: tasks.state,
      taskType: tasks.taskType,
      prUrl: tasks.prUrl,
      prNumber: tasks.prNumber,
      prState: tasks.prState,
      errorMessage: tasks.errorMessage,
      ticketSource: tasks.ticketSource,
      ticketExternalId: tasks.ticketExternalId,
      metadata: tasks.metadata,
      workspaceId: tasks.workspaceId,
      ownerUserId: tasks.ownerUserId,
      ownerTeamId: tasks.ownerTeamId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  return row ?? null;
}

export type RoundTripTask = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

/** What the triggers that make work wait for a person mean, in words fit for the ticket. */
const WAITING_BECAUSE: Record<string, string> = {
  plan_review: "its plan is ready for review",
  completed_without_pr: "the agent finished without opening a merge request",
  merge_conflicts: "its merge request has conflicts",
  ci_failing: "its merge request's pipeline fails",
  review_changes_requested: "a review asked for changes",
};

/**
 * The reason a ticket may read: the trigger's words, else the error's class
 * (error-classifier.ts's title, e.g. "Agent exited with code 1") — never the
 * error message itself, which can end with the agent's stderr and is for
 * those who may see the work, not everyone who may browse the ticket's project.
 * Empty when neither says anything; the run's link has the details.
 */
export function publicReason(
  trigger: string | null | undefined,
  errorMessage: string | null | undefined,
): string {
  if (trigger && WAITING_BECAUSE[trigger]) return WAITING_BECAUSE[trigger];
  if (!errorMessage?.trim()) return "";
  const classified = classifyError(errorMessage);
  return classified.category === "unknown" ? "" : classified.title;
}

/**
 * The provider a task's ticket came through: the one the sync noted
 * (`metadata.ticketProviderId`), else — work from before that — a provider
 * of the ticket's source, workspace and owner, for a source whose ticket ids
 * are unique across the service (a GitHub or GitLab issue number names an
 * issue only within its repository: that work gets none).
 */
export async function providerForTask(task: {
  metadata?: unknown;
  ticketSource: string | null;
  workspaceId?: string | null;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
}): Promise<ProviderRow | null> {
  const noted = (task.metadata as Record<string, unknown> | null)?.ticketProviderId;
  if (typeof noted === "string" && noted) {
    const [row] = await db.select().from(ticketProviders).where(eq(ticketProviders.id, noted));
    return row ?? null;
  }
  if (!roundTripSupport(task.ticketSource)?.uniqueIds) return null;
  const [row] = await db
    .select()
    .from(ticketProviders)
    .where(
      and(
        eq(ticketProviders.source, task.ticketSource!),
        task.workspaceId
          ? or(
              eq(ticketProviders.workspaceId, task.workspaceId),
              isNull(ticketProviders.workspaceId),
            )
          : undefined,
        task.ownerUserId
          ? eq(ticketProviders.ownerUserId, task.ownerUserId)
          : isNull(ticketProviders.ownerUserId),
        task.ownerTeamId
          ? eq(ticketProviders.ownerTeamId, task.ownerTeamId)
          : isNull(ticketProviders.ownerTeamId),
      ),
    )
    .orderBy(ticketProviders.createdAt)
    .limit(1);
  return row ?? null;
}

/** Whether a completed task's MR was merged (the rule notify/dispatch.ts uses). */
function mergedMr(task: Pick<RoundTripTask, "prUrl" | "prState">): boolean {
  return task.prState === "merged" || (!!task.prUrl && task.prState !== "closed");
}

/** `!12` for a GitLab MR, `#12` for a GitHub PR, from its number or its URL. */
export function mrLabel(prUrl: string | null | undefined, prNumber?: number | null): string {
  const n = prNumber ?? Number(prUrl?.match(/\/(?:merge_requests|pull)\/(\d+)/)?.[1] ?? NaN);
  if (!Number.isFinite(n)) return "merge request";
  return prUrl?.includes("/pull/") ? `#${n}` : `!${n}`;
}

/** What the platform calls it: a pull request on GitHub, else a merge request. */
export function mrNoun(prUrl: string | null | undefined): string {
  return prUrl?.includes("/pull/") ? "pull request" : "merge request";
}

interface NewEvent {
  event: WritebackEvent;
  key: string;
  details?: Record<string, unknown>;
  /** Not sent now: the retry sweep sends it when it is still true later. */
  deferred?: boolean;
}

/** Adds the event's row unless its key is already there; the new row's id, else null. */
export async function recordWriteback(
  e: NewEvent & {
    taskId: string | null;
    providerId: string | null;
    ticketSource: string;
    ticketExternalId: string;
    status?: WritebackRow["status"];
  },
): Promise<string | null> {
  const rows = await db
    .insert(ticketWritebacks)
    .values({
      dedupeKey: e.key,
      taskId: e.taskId,
      providerId: e.providerId,
      ticketSource: e.ticketSource,
      ticketExternalId: e.ticketExternalId,
      event: e.event,
      status: e.status ?? "pending",
      details: e.details ?? null,
    })
    .onConflictDoNothing({ target: ticketWritebacks.dedupeKey })
    .returning({ id: ticketWritebacks.id });
  return rows[0]?.id ?? null;
}

/** The follow-up a resumed task hasn't answered yet (ticket-follow-ups.ts writes them). */
async function unansweredFollowUp(taskId: string) {
  const [row] = await db
    .select({ id: ticketWritebacks.id, details: ticketWritebacks.details })
    .from(ticketWritebacks)
    .where(
      and(
        eq(ticketWritebacks.taskId, taskId),
        eq(ticketWritebacks.event, "follow_up"),
        sql`${ticketWritebacks.details}->>'head' = 'true'`,
        sql`coalesce(${ticketWritebacks.details}->>'answered', 'false') = 'false'`,
      ),
    )
    .orderBy(desc(ticketWritebacks.createdAt))
    .limit(1);
  return row ?? null;
}

async function markAnswered(rowId: string) {
  await db
    .update(ticketWritebacks)
    .set({
      details: sql`coalesce(${ticketWritebacks.details}, '{}'::jsonb) || '{"answered": true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(ticketWritebacks.id, rowId));
}

/** The events a transition into `toState` makes, for a task as it is now. */
async function eventsFor(
  task: RoundTripTask,
  toState: string,
  at: Date,
  trigger: string | null,
): Promise<NewEvent[]> {
  const stamp = at.toISOString();
  switch (toState) {
    case TaskState.QUEUED:
    case TaskState.PROVISIONING:
    case TaskState.RUNNING:
      return [{ event: "started", key: `${task.id}:started` }];
    case TaskState.PR_OPENED: {
      if (!task.prUrl) return [];
      const openedKey = `${task.id}:mr_opened:${task.prUrl}`;
      const [opened] = await db
        .select({ id: ticketWritebacks.id })
        .from(ticketWritebacks)
        .where(eq(ticketWritebacks.dedupeKey, openedKey))
        .limit(1);
      const followUp = await unansweredFollowUp(task.id);
      if (followUp) await markAnswered(followUp.id);
      // A new MR is announced as such; the same MR back after a follow-up
      // from the ticket answers that comment.
      if (!opened) {
        return [
          {
            event: "mr_opened",
            key: openedKey,
            details: { prUrl: task.prUrl, prNumber: task.prNumber },
          },
        ];
      }
      if (!followUp) return [];
      return [
        {
          event: "mr_updated",
          key: `${task.id}:mr_updated:${followUp.id}`,
          details: { prUrl: task.prUrl, prNumber: task.prNumber, author: followUp.details?.author },
        },
      ];
    }
    case TaskState.COMPLETED:
      await answerFollowUps(task.id);
      return mergedMr(task)
        ? [
            {
              event: "merged",
              key: `${task.id}:merged`,
              details: { prUrl: task.prUrl, prNumber: task.prNumber },
            },
          ]
        : [];
    case TaskState.FAILED:
      await answerFollowUps(task.id);
      return [
        {
          event: "failed",
          key: `${task.id}:failed:${stamp}`,
          details: { reason: publicReason(trigger, task.errorMessage), prUrl: task.prUrl },
        },
      ];
    case TaskState.NEEDS_ATTENTION:
      return [
        {
          event: "needs_attention",
          key: `${task.id}:attention:${stamp}`,
          details: { reason: publicReason(trigger, task.errorMessage), prUrl: task.prUrl },
          deferred: true,
        },
      ];
    default:
      return [];
  }
}

async function answerFollowUps(taskId: string) {
  const open = await unansweredFollowUp(taskId);
  if (open) await markAnswered(open.id);
}

/**
 * What a committed transition means for the ticket the work came from: the
 * events it makes are recorded and sent (task-service.ts calls this once per
 * transition; work not from a ticket of a provider with the round trip on
 * returns at once). Never throws.
 */
export async function onTicketWorkTransition(t: {
  taskId: string;
  toState: string;
  /** Why it moved (`ci_failing`, `plan_review`, …): the reason a ticket may read. */
  trigger?: string | null;
  at?: Date | string | null;
}): Promise<void> {
  try {
    const task = await loadTask(t.taskId);
    if (!task || !getTicketRoundTrip(task.ticketSource) || !task.ticketExternalId) return;
    if (task.taskType === "review") return;
    const provider = await providerForTask(task);
    if (!provider) {
      logger.debug(
        { taskId: task.id, source: task.ticketSource },
        "[ticket-writeback] No ticket provider for this work's ticket",
      );
      return;
    }
    if (provider.source !== task.ticketSource || !roundTripSettings(provider.config).enabled) {
      return;
    }
    const at = t.at ? new Date(t.at) : new Date();
    const events = await eventsFor(
      task,
      t.toState,
      Number.isNaN(at.getTime()) ? new Date() : at,
      t.trigger ?? null,
    );
    for (const e of events) {
      const id = await recordWriteback({
        ...e,
        taskId: task.id,
        providerId: provider.id,
        ticketSource: task.ticketSource!,
        ticketExternalId: task.ticketExternalId,
      });
      if (id && !e.deferred) await deliverWriteback(id);
    }
  } catch (err) {
    logger.warn({ err, taskId: t.taskId }, "[ticket-writeback] Could not write back to the ticket");
  }
}

/** The steps an event takes under these settings, in order, of those the service supports. */
export function stepsFor(
  event: WritebackEvent,
  s: TicketRoundTripSettings,
  can: { links: boolean; statuses: boolean } = { links: true, statuses: true },
): Step[] {
  const steps: Step[] = [];
  if (s.comments) steps.push("comment");
  const mapped = STEP_OF[event];
  if (can.statuses && mapped && s.transitions[mapped]) steps.push("transition");
  if (can.links && s.remoteLink && LINKED.has(event)) steps.push("link");
  return steps;
}

interface Context {
  taskId: string | null;
  title: string;
  runUrl: string | null;
  prUrl: string | null;
  prNumber: number | null;
  details: Record<string, unknown>;
}

function runLink(ctx: Context, text = "the run"): CommentPart[] {
  return ctx.runUrl ? [{ text, href: ctx.runUrl }] : [`run ${ctx.taskId ?? ""}`.trim()];
}

function mrLink(ctx: Context): CommentPart {
  const n = mrLabel(ctx.prUrl, ctx.prNumber);
  const noun = mrNoun(ctx.prUrl);
  const label = n === "merge request" ? noun : `${noun} ${n}`;
  return ctx.prUrl ? { text: label, href: ctx.prUrl } : label;
}

/** The comment an event posts, as text and links (each service's round trip renders it). */
export function commentFor(event: WritebackEvent, ctx: Context): CommentPart[] | null {
  const reason = typeof ctx.details.reason === "string" && ctx.details.reason;
  const author = typeof ctx.details.author === "string" && ctx.details.author;
  switch (event) {
    case "started":
      return ["Optio started work on this ticket. Follow ", ...runLink(ctx), "."];
    case "mr_opened":
      return ["Optio opened ", mrLink(ctx), " for this ticket (", ...runLink(ctx), ")."];
    case "mr_updated":
      return [
        `Optio pushed changes for ${author ? `${author}'s comment` : "the comment"} to `,
        mrLink(ctx),
        " (",
        ...runLink(ctx),
        ").",
      ];
    case "merged":
      return ["Optio's ", mrLink(ctx), " was merged."];
    case "failed":
      return [`Optio's run failed${reason ? `: ${reason}` : ""}. Details: `, ...runLink(ctx), "."];
    case "needs_attention":
      return [
        `Optio is waiting for a person${reason ? `: ${reason}` : ""}. See `,
        ...runLink(ctx),
        ".",
      ];
    case "follow_up":
      return [
        `Optio is working on ${author ? `${author}'s comment` : "the comment above"}: `,
        ...runLink(ctx),
        ".",
      ];
    case "follow_up_limit":
      return [
        `Optio has picked up ${String(ctx.details.limit ?? "")} comments on this ticket and won't take more for this work. Continue from `,
        ...runLink(ctx),
        ".",
      ];
    case "skipped":
      return [typeof ctx.details.why === "string" ? ctx.details.why : "Optio skipped this ticket."];
    default:
      return null;
  }
}

const LINK_SUMMARY: Partial<Record<WritebackEvent, string>> = {
  started: "In progress",
  mr_opened: "Waiting for review",
  mr_updated: "Updated, waiting for review",
  merged: "Merged",
  failed: "Failed",
  needs_attention: "Waiting for a person",
};

/** The work's link an event leaves on the ticket, or null without anywhere to point. */
export function remoteLinkFor(event: WritebackEvent, ctx: Context) {
  const url = ctx.prUrl ?? ctx.runUrl;
  if (!url || !ctx.taskId) return null;
  const reason = typeof ctx.details.reason === "string" ? ctx.details.reason : "";
  const summary = LINK_SUMMARY[event] ?? "";
  return {
    globalId: `optio:${ctx.taskId}`,
    url,
    title: ctx.prUrl
      ? `${mrNoun(ctx.prUrl) === "pull request" ? "Pull request" : "Merge request"} ${mrLabel(ctx.prUrl, ctx.prNumber)}: ${ctx.title}`
      : `Optio: ${ctx.title}`,
    summary:
      reason && (event === "failed" || event === "needs_attention")
        ? `${summary}: ${reason}`
        : summary,
    resolved: event === "merged",
    iconUrl: absoluteLink("/favicon-32.png") ?? undefined,
  };
}

/**
 * A newer event about the same work whose `step` already reached the ticket,
 * or null. Retries wait attempts² minutes each, so an older event can come
 * due after a newer one: its status move would take the ticket back (In
 * Review → In Progress), its link would be relabelled, its comment would
 * read out of order. Only that step is out of date — a newer "waiting for a
 * person" moves nothing, so a late start still moves the ticket to In
 * Progress. The newer event's name, for the row's note.
 */
async function newerStepSent(row: WritebackRow, step: Step): Promise<string | null> {
  if (!row.taskId || !LINKED.has(row.event as WritebackEvent)) return null;
  const [hit] = await db
    .select({ event: ticketWritebacks.event })
    .from(ticketWritebacks)
    .where(
      and(
        eq(ticketWritebacks.taskId, row.taskId),
        inArray(ticketWritebacks.event, [...LINKED]),
        sql`${ticketWritebacks.id} <> ${row.id}`,
        sql`${ticketWritebacks.createdAt} > (SELECT w.created_at FROM ticket_writebacks w WHERE w.id = ${row.id})`,
        sql`${ticketWritebacks.doneSteps} @> ${JSON.stringify([step])}::jsonb`,
      ),
    )
    .orderBy(desc(ticketWritebacks.createdAt))
    .limit(1);
  return hit?.event ?? null;
}

/**
 * Sends one row's remaining steps. Only one sender holds a row at a time
 * (`sending`, taken back after five minutes); a failed step leaves the row
 * `failed` for the retry sweep. A step a newer event of the work already did
 * is left out (`newerStepSent`, checked before each step); a row with
 * nothing left that went through is `skipped`. The outcome, or `busy` when
 * someone else holds it or it is finished.
 */
export async function deliverWriteback(
  rowId: string,
): Promise<"done" | "failed" | "skipped" | "busy"> {
  const now = new Date();
  const [row] = await db
    .update(ticketWritebacks)
    .set({
      status: "sending",
      claimedAt: now,
      attempts: sql`${ticketWritebacks.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(ticketWritebacks.id, rowId),
        or(
          inArray(ticketWritebacks.status, ["pending", "failed"]),
          and(
            eq(ticketWritebacks.status, "sending"),
            lt(ticketWritebacks.claimedAt, sql`now() - interval '5 minutes'`),
          ),
        ),
      ),
    )
    .returning();
  if (!row) return "busy";

  const finish = async (status: "done" | "skipped" | "failed", lastError?: string | null) => {
    await db
      .update(ticketWritebacks)
      .set({ status, lastError: lastError ?? null, claimedAt: null, updatedAt: new Date() })
      .where(eq(ticketWritebacks.id, row.id));
    return status;
  };

  try {
    const task = row.taskId ? await loadTask(row.taskId) : null;
    const [provider] = row.providerId
      ? await db.select().from(ticketProviders).where(eq(ticketProviders.id, row.providerId))
      : [];
    if (!provider) return await finish("skipped", "The ticket provider is gone");
    if (!provider.enabled) return await finish("failed", "The ticket provider is disabled");
    const rt = getTicketRoundTrip(provider.source);
    if (!rt) return await finish("skipped", `No round trip for ${provider.source} tickets`);

    const settings = roundTripSettings(provider.config);
    if (!settings.enabled) {
      return await finish("skipped", "The round trip is off for this provider");
    }
    const { resolveProviderConfig } = await import("./ticket-sync-service.js");
    let config = await resolveProviderConfig(provider);
    const details = (row.details ?? {}) as Record<string, unknown>;
    if (provider.source === "gitlab") {
      const url = (task?.metadata as { ticketUrl?: string } | null)?.ticketUrl ?? details.ticketUrl;
      config = gitLabRoundTripConfig(config, typeof url === "string" ? url : null);
    }
    const prUrl = (typeof details.prUrl === "string" && details.prUrl) || task?.prUrl || null;
    const ctx: Context = {
      taskId: row.taskId,
      title: task?.title ?? row.ticketExternalId,
      runUrl: row.taskId ? runUrlOf(row.taskId) : null,
      prUrl,
      prNumber:
        (typeof details.prNumber === "number" ? details.prNumber : null) ?? task?.prNumber ?? null,
      details,
    };
    const done = new Set(row.doneSteps ?? []);
    let commentId = row.commentId;
    let linkId = row.linkId;
    let note: string | null = null;
    const overtaken: Step[] = [];
    let newerEvent: string | null = null;
    for (const step of stepsFor(row.event as WritebackEvent, settings, rt.capabilities)) {
      if (done.has(step)) continue;
      const newer = await newerStepSent(row, step);
      if (newer) {
        overtaken.push(step);
        newerEvent ??= newer;
        continue;
      }
      if (step === "comment") {
        const parts = commentFor(row.event as WritebackEvent, ctx);
        if (parts) commentId = (await rt.postComment(row.ticketExternalId, parts, config)).id;
      } else if (step === "transition") {
        const mapped = STEP_OF[row.event as WritebackEvent]!;
        const target = settings.transitions[mapped];
        const others = ROUND_TRIP_STEPS.filter((x) => x !== mapped)
          .map((x) => settings.transitions[x])
          .filter(Boolean);
        const moved = await rt.moveToStatus(row.ticketExternalId, target, config, { others });
        if (moved.reason === "unreachable") {
          // Retrying won't make a transition appear: noted, not failed.
          note = `${row.ticketExternalId} is in "${moved.from ?? "?"}"; no transition leads to "${target}" (it can go to ${moved.available?.join(", ") || "nothing"})`;
        }
      } else {
        const link = remoteLinkFor(row.event as WritebackEvent, ctx);
        if (link) {
          const previousId = row.taskId ? await lastLinkId(row.taskId) : null;
          linkId =
            (await rt.upsertLink(row.ticketExternalId, { ...link, previousId }, config)).id ??
            linkId;
        }
      }
      done.add(step);
      await db
        .update(ticketWritebacks)
        .set({ doneSteps: [...done], commentId, linkId, updatedAt: new Date() })
        .where(eq(ticketWritebacks.id, row.id));
    }
    if (overtaken.length) {
      const why = `Out of date, left out ${overtaken.join(", ")}: the newer "${newerEvent}" already reached ${row.ticketExternalId}`;
      return await finish(done.size ? "done" : "skipped", note ? `${note}; ${why}` : why);
    }
    return await finish("done", note);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: message, rowId: row.id, event: row.event, ticket: row.ticketExternalId },
      "[ticket-writeback] Writing to the ticket failed; the ticket sync tries again",
    );
    return await finish("failed", message.slice(0, 500));
  }
}

/**
 * The retry sweep, run by the ticket sync for each enabled provider: rows not
 * sent yet (failed, or a sender that died), each after attempts² minutes, for
 * a day; and "needs a person" rows once the grace has passed — sent if the
 * work still waits, skipped if it moved on. The number of rows it sent.
 */
export async function retryTicketWritebacks(providerId: string): Promise<number> {
  const rows = await db
    .select()
    .from(ticketWritebacks)
    .where(
      and(
        eq(ticketWritebacks.providerId, providerId),
        inArray(ticketWritebacks.status, ["pending", "failed", "sending"]),
        lt(ticketWritebacks.attempts, MAX_ATTEMPTS),
        sql`${ticketWritebacks.createdAt} > now() - interval '1 day'`,
        sql`(${ticketWritebacks.status} <> 'sending' OR ${ticketWritebacks.claimedAt} < now() - interval '5 minutes')`,
        sql`(${ticketWritebacks.status} <> 'failed' OR ${ticketWritebacks.updatedAt} < now() - make_interval(mins => ${ticketWritebacks.attempts} * ${ticketWritebacks.attempts}))`,
      ),
    )
    .orderBy(ticketWritebacks.createdAt)
    .limit(50);
  let sent = 0;
  for (const row of rows) {
    if (row.event === "needs_attention") {
      if (row.status === "pending" && Date.now() - row.createdAt.getTime() < ATTENTION_GRACE_MS) {
        continue;
      }
      // Sent (or tried again) only while the work still waits.
      const task = row.taskId ? await loadTask(row.taskId) : null;
      if (!task || task.state !== TaskState.NEEDS_ATTENTION) {
        await db
          .update(ticketWritebacks)
          .set({ status: "skipped", lastError: "The work moved on", updatedAt: new Date() })
          .where(and(eq(ticketWritebacks.id, row.id), eq(ticketWritebacks.status, row.status)));
        continue;
      }
    }
    if ((await deliverWriteback(row.id)) === "done") sent++;
  }
  return sent;
}

/** The link the work's newest event left (a comment or an attachment), for the next to update. */
async function lastLinkId(taskId: string): Promise<string | null> {
  const [hit] = await db
    .select({ linkId: ticketWritebacks.linkId })
    .from(ticketWritebacks)
    .where(and(eq(ticketWritebacks.taskId, taskId), sql`${ticketWritebacks.linkId} IS NOT NULL`))
    .orderBy(desc(ticketWritebacks.updatedAt))
    .limit(1);
  return hit?.linkId ?? null;
}

/**
 * A ticket the sync skips because no repository matches it gets one
 * comment saying so. Not the backlog: a ticket skipped by a provider's first
 * sweep, or by the first sweep since the round trip came (no `since` mark
 * yet, ticket-round-trip-marks.ts), is recorded as `skipped` without a word,
 * and that row keeps every later sweep quiet about it too. Never throws.
 */
export async function noteTicketSkipped(input: {
  provider: { id: string; source: string; config: unknown };
  ticket: Pick<Ticket, "externalId" | "source" | "repo"> & { url?: string };
  firstSync: boolean;
}): Promise<void> {
  const { provider, ticket } = input;
  if (provider.source !== ticket.source || !getTicketRoundTrip(provider.source)) return;
  const settings = roundTripSettings(provider.config);
  if (!settings.enabled) return;
  const backlog = input.firstSync || !roundTripMarks(provider.config).since;
  try {
    if (!backlog && !settings.comments) return;
    const why = ticket.repo
      ? `Optio can't work on this ticket: no repository it knows matches the label "repo:${ticket.repo}". Add the repository to Optio (Repositories), or fix the label, and Optio picks the ticket up at its next sync.`
      : `Optio can't work on this ticket: it doesn't say which repository the work is for. Add a label "repo:<owner>/<name>" naming the repository, and Optio picks the ticket up at its next sync.`;
    const id = await recordWriteback({
      event: "skipped",
      key: `skip:${provider.id}:${ticket.externalId}`,
      details: {
        why,
        ...(backlog ? { backlog: true } : {}),
        ...(ticket.url ? { ticketUrl: ticket.url } : {}),
      },
      status: backlog ? "skipped" : "pending",
      taskId: null,
      providerId: provider.id,
      ticketSource: provider.source,
      ticketExternalId: ticket.externalId,
    });
    if (id && !backlog) await deliverWriteback(id);
  } catch (err) {
    logger.warn(
      { err, ticket: ticket.externalId },
      "[ticket-writeback] Could not note a skipped ticket",
    );
  }
}

/** The comment ids Optio posted on a ticket, its link comments too (the follow-up poll's loop guard). */
export async function optioCommentIds(
  ticketSource: string,
  ticketExternalId: string,
  provider: Pick<ProviderRow, "id" | "config">,
): Promise<Set<string>> {
  const rows = await db
    .select({
      commentId: ticketWritebacks.commentId,
      linkId: ticketWritebacks.linkId,
      providerId: ticketWritebacks.providerId,
      config: ticketProviders.config,
    })
    .from(ticketWritebacks)
    .leftJoin(ticketProviders, eq(ticketProviders.id, ticketWritebacks.providerId))
    .where(
      and(
        eq(ticketWritebacks.ticketSource, ticketSource),
        eq(ticketWritebacks.ticketExternalId, ticketExternalId),
        sql`(${ticketWritebacks.commentId} IS NOT NULL OR ${ticketWritebacks.linkId} IS NOT NULL)`,
      ),
    );
  const namespace = commentNamespace(ticketSource, provider.config);
  return new Set(
    rows
      .filter(
        (r) =>
          r.providerId === provider.id ||
          (namespace !== null && namespace === commentNamespace(ticketSource, r.config)),
      )
      .flatMap((r) => [r.commentId, r.linkId])
      .filter((x): x is string => !!x),
  );
}

/** Numeric comment ids are local to a self-hosted instance, not the whole service. */
function commentNamespace(source: string, config: unknown): string | null {
  if (source !== "gitlab" && source !== "jira") return source;
  if (!config || typeof config !== "object") return null;
  const c = config as { host?: string; baseUrl?: string };
  const raw = source === "gitlab" ? c.host || "gitlab.com" : c.baseUrl;
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
