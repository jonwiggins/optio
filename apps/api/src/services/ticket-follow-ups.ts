/**
 * The ticket round trip's reading half (docs/ticket-round-trip.md
 * "Follow-ups from the ticket"): a person's new comment on the ticket resumes
 * the work it became, with the comment as the instruction, while that work
 * waits for a person (`needs_attention`) or has its merge request open
 * (`pr_opened`).
 *
 * Poll-based: the ticket sync (every OPTIO_TICKET_SYNC_INTERVAL, one runner
 * under its poller lease) calls `ticketRoundTripSweep` for each enabled
 * provider after its tickets; providers whose round trip is off are left
 * alone. The comments are read through the service's TicketRoundTrip
 * (@optio/ticket-providers). Each sweep reads up to 25 pieces of waiting work
 * per provider, taking turns, so all of it is read in time. Which comments
 * count is the provider's `followUps` setting: `any` person's, only ones that
 * `mention` Optio (`/optio …`, `@optio`, or the provider's account in the
 * service's syntax), or `off`.
 *
 * Loop guards, so Optio never answers itself:
 *   - comments Optio posted (their ids are kept in `ticket_writebacks`) and
 *     every comment written as the provider's own account are never read;
 *   - comments by apps and integrations (GitHub Apps, Linear's bots, the
 *     notes a code host's integration leaves on a Jira issue, "… mentioned
 *     this issue in a merge request …") are not instructions;
 *   - only comments newer than the work (older ones were in its prompt), than
 *     the round trip on this provider and than the last widening of its
 *     follow-ups (ticket-round-trip-marks.ts: an upgrade, or Off → Any, doesn't
 *     replay old conversation), each taken once (`<task id>:follow_up:<comment id>`);
 *   - at most OPTIO_TICKET_FOLLOW_UP_LIMIT (10) follow-ups per piece of work;
 *     then one comment says so and the rest wait for a person in Optio;
 *   - the start comment and status move happen once per work, not per resume.
 *
 * Who may steer: the work runs with its owner's credentials, so a comment
 * is an instruction only from someone the service says may change the work's
 * repository or project — on GitHub an owner, member or collaborator of the
 * repository (`author_association`), on GitLab a Developer or above of the
 * project (`mayInstruct`), on Jira anyone but an app or a Service Management
 * customer, on Linear and Notion a member of the workspace (their comments
 * need an account there). Anyone else's comment is left alone, and isn't
 * taken, so it never counts against the limit.
 */
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { TaskState, parseIntEnv, roundTripSettings, roundTripSupport } from "@optio/shared";
import {
  getTicketRoundTrip,
  gitLabRoundTripConfig,
  parseTicketTime,
  sameTicketAccount,
  type TicketAccount,
  type TicketCommentRecord,
  type TicketRoundTrip,
} from "@optio/ticket-providers";
import { db } from "../db/client.js";
import { tasks, ticketProviders, ticketWritebacks } from "../db/schema.js";
import { logger } from "../logger.js";
import * as taskService from "./task-service.js";
import { ensureRoundTripSince, followUpFloor, roundTripMarks } from "./ticket-round-trip-marks.js";
import {
  deliverWriteback,
  madeBySyncOf,
  mrNoun,
  optioCommentIds,
  recordWriteback,
  retryTicketWritebacks,
} from "./ticket-writeback.js";

type ProviderRow = typeof ticketProviders.$inferSelect;

/** Follow-ups one piece of work takes from its ticket (OPTIO_TICKET_FOLLOW_UP_LIMIT). */
export function followUpLimit(): number {
  return Math.max(1, parseIntEnv("OPTIO_TICKET_FOLLOW_UP_LIMIT", 10));
}

/** Waiting work the poll reads comments for, per provider and sweep. */
export const MAX_TASKS_PER_SWEEP = 25;

/**
 * The instruction in a comment that mentions Optio, or null when it doesn't:
 * `/optio …` or `@optio` anywhere, or a mention of the provider's account in
 * the service's syntax (`roundTrip.mentionsAccount`).
 */
export function mentionedInstruction(
  body: string,
  account: TicketAccount | null,
  roundTrip: TicketRoundTrip,
): string | null {
  const text = body.trim();
  const slash = text.match(/^\/optio\b[:,]?\s*([\s\S]*)$/i);
  if (slash) return slash[1].trim() || text;
  if (/(^|[^\w@])@optio\b/i.test(text)) return text;
  return roundTrip.mentionsAccount(text, account) ? text : null;
}

/**
 * The comments on a waiting task's ticket that are instructions for it:
 * newer than the work and than `since` (the provider's follow-up floor), not
 * Optio's, not taken already, and — in `mention` mode — addressed to Optio.
 * A comment without a readable time is not taken. Pure, for tests.
 */
export function followUpCandidates(input: {
  comments: TicketCommentRecord[];
  taskCreatedAt: Date;
  since?: Date | null;
  optioIds: Set<string>;
  taken: Set<string>;
  account: TicketAccount | null;
  mode: "any" | "mention";
  /** The service's round trip: its mention syntax and its integrations' notes. */
  roundTrip: TicketRoundTrip;
}): Array<TicketCommentRecord & { instruction: string }> {
  const rt = input.roundTrip;
  const out: Array<TicketCommentRecord & { instruction: string }> = [];
  const floor = Math.max(input.taskCreatedAt.getTime(), input.since?.getTime() ?? 0);
  for (const c of input.comments) {
    if (input.optioIds.has(c.id) || input.taken.has(c.id)) continue;
    if (c.bot || c.trusted === false || sameTicketAccount(c.author, input.account)) continue;
    const at = parseTicketTime(c.created);
    if (at === null || at <= floor) continue;
    const body = c.body.trim();
    if (!body || rt.isIntegrationNote?.(body)) continue;
    const instruction =
      input.mode === "mention" ? mentionedInstruction(body, input.account, rt) : body;
    if (instruction) out.push({ ...c, instruction });
  }
  return out;
}

/** The resume prompt: what the people said, and to keep to the open MR. */
export function followUpPrompt(input: {
  ticketKey: string;
  /** The ticket's source, for its name ("the Jira ticket PLAT-1", "the GitHub issue 12"). */
  source?: string | null;
  comments: Array<{ author: string; instruction: string }>;
  prUrl: string | null;
  branch: string;
}): string {
  const quoted = input.comments
    .map(
      (c) =>
        `${c.author} wrote:\n${c.instruction
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n")}`,
    )
    .join("\n\n");
  const one = input.comments.length === 1;
  const noun = roundTripSupport(input.source)?.noun ?? "ticket";
  const mr = mrNoun(input.prUrl);
  return [
    `${one ? "A person commented" : "People commented"} on the ${noun} ${input.ticketKey} this work came from:`,
    "",
    quoted,
    "",
    `Do what ${one ? "the comment asks" : "the comments ask"}.` +
      (input.prUrl
        ? ` Your ${mr} ${input.prUrl} is still open: commit and push to the same branch (${input.branch}); do NOT open a new ${mr}.`
        : ""),
  ].join("\n");
}

function authorName(c: TicketCommentRecord): string {
  return c.author.displayName || c.author.name || "Someone";
}

/**
 * Where each provider's last sweep stopped (a task id): the next one reads
 * on from there and wraps around, so with more waiting work than a sweep
 * reads, every piece is read within a few sweeps — none is starved by work
 * that waits for ever. Kept by the runner that holds the poller lease; a
 * new runner starts from the beginning.
 */
const sweepCursor = new Map<string, string>();

/**
 * Waiting work the sync made from this provider's tickets: it names the
 * provider and the sync's claim on its ticket names it (`madeBySyncOf`,
 * ticket-writeback.ts), so a task anyone created saying it came from a
 * ticket is never steered by that ticket's comments.
 */
function waitingPage(
  provider: ProviderRow,
  limit: number,
  range: { after?: string; upTo?: string } = {},
) {
  return db
    .select({
      id: tasks.id,
      state: tasks.state,
      createdAt: tasks.createdAt,
      prUrl: tasks.prUrl,
      sessionId: tasks.sessionId,
      ticketExternalId: tasks.ticketExternalId,
      metadata: tasks.metadata,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.ticketSource, provider.source),
        inArray(tasks.state, [TaskState.NEEDS_ATTENTION, TaskState.PR_OPENED]),
        sql`${tasks.ticketExternalId} IS NOT NULL`,
        sql`${tasks.metadata}->>'ticketProviderId' = ${provider.id}`,
        madeBySyncOf(provider),
        range.after ? gt(tasks.id, range.after) : undefined,
        range.upTo ? lte(tasks.id, range.upTo) : undefined,
      ),
    )
    .orderBy(tasks.id)
    .limit(limit);
}

/** This sweep's turn of the provider's waiting work: up to MAX_TASKS_PER_SWEEP, on from the last. */
async function waitingTasks(provider: ProviderRow) {
  const after = sweepCursor.get(provider.id);
  let rows = await waitingPage(provider, MAX_TASKS_PER_SWEEP, { after });
  if (after && rows.length < MAX_TASKS_PER_SWEEP) {
    // Wrap around to the start, up to where this turn began.
    rows = [
      ...rows,
      ...(await waitingPage(provider, MAX_TASKS_PER_SWEEP - rows.length, { upTo: after })),
    ];
  }
  if (rows.length === MAX_TASKS_PER_SWEEP) sweepCursor.set(provider.id, rows[rows.length - 1].id);
  else sweepCursor.delete(provider.id);
  return rows;
}

async function takenCommentIds(taskId: string): Promise<{ ids: Set<string>; count: number }> {
  const rows = await db
    .select({ key: ticketWritebacks.dedupeKey, details: ticketWritebacks.details })
    .from(ticketWritebacks)
    .where(and(eq(ticketWritebacks.taskId, taskId), eq(ticketWritebacks.event, "follow_up")));
  const prefix = `${taskId}:follow_up:`;
  const ids = new Set(rows.map((r) => r.key.slice(prefix.length)));
  const count = rows.filter((r) => (r.details as Record<string, unknown> | null)?.head).length;
  return { ids, count };
}

/**
 * Reads the comments on the tickets of this provider's waiting work and
 * resumes each piece of work that has new instructions. The number resumed.
 */
export async function pollTicketFollowUps(
  provider: ProviderRow,
  config: Record<string, unknown>,
): Promise<number> {
  const rt = getTicketRoundTrip(provider.source);
  if (!rt) return 0;
  const settings = roundTripSettings(provider.config);
  if (!settings.enabled || settings.followUps === "off") return 0;
  const since = followUpFloor(roundTripMarks(provider.config));
  const waiting = await waitingTasks(provider);
  if (!waiting.length) return 0;

  const account = await rt.whoAmI(config).catch((err) => {
    // Without knowing its own account the poll can't tell Optio's comments
    // by author; the comment ids still guard, but don't risk it.
    logger.warn(
      { err, providerId: provider.id, source: provider.source },
      "[ticket-follow-ups] Couldn't tell the provider's own account",
    );
    return null;
  });
  if (!account) return 0;

  let resumed = 0;
  for (const task of waiting) {
    try {
      if (
        await resumeFromComments(provider, config, rt, account, settings.followUps, since, task)
      ) {
        resumed++;
      }
    } catch (err) {
      logger.warn(
        { err, taskId: task.id, ticket: task.ticketExternalId },
        "[ticket-follow-ups] Could not read the ticket's comments",
      );
    }
  }
  return resumed;
}

async function resumeFromComments(
  provider: ProviderRow,
  config: Record<string, unknown>,
  rt: TicketRoundTrip,
  account: TicketAccount,
  mode: "any" | "mention",
  since: Date | null,
  task: Awaited<ReturnType<typeof waitingTasks>>[number],
): Promise<boolean> {
  const key = task.ticketExternalId!;
  if (provider.source === "gitlab") {
    const url = (task.metadata as { ticketUrl?: string } | null)?.ticketUrl;
    config = gitLabRoundTripConfig(config, url);
  }
  const comments = await rt.listComments(key, config);
  const { ids: taken, count } = await takenCommentIds(task.id);
  let candidates = followUpCandidates({
    comments,
    taskCreatedAt: task.createdAt,
    since,
    optioIds: await optioCommentIds(provider.source, key, provider),
    taken,
    account,
    mode,
    roundTrip: rt,
  });
  if (!candidates.length) return false;

  const base = {
    taskId: task.id,
    providerId: provider.id,
    ticketSource: provider.source,
    ticketExternalId: key,
  };
  // A service that says per author who may change the project (GitLab). A
  // comment it refuses is taken as skipped, so it is asked about once, and
  // never counts against the limit.
  if (rt.mayInstruct) {
    const verdicts = new Map<string, Promise<boolean>>();
    const may = (c: (typeof candidates)[number]) => {
      const who = c.author.accountId ?? c.author.name ?? "";
      if (!verdicts.has(who)) verdicts.set(who, rt.mayInstruct!(key, c.author, config));
      return verdicts.get(who)!;
    };
    const allowed: typeof candidates = [];
    for (const c of candidates) {
      if (await may(c)) {
        allowed.push(c);
        continue;
      }
      await recordWriteback({
        ...base,
        event: "follow_up",
        key: `${task.id}:follow_up:${c.id}`,
        status: "skipped",
        details: { author: authorName(c), commentId: c.id, notAllowed: true },
      });
    }
    candidates = allowed;
    if (!candidates.length) return false;
  }
  if (count >= followUpLimit()) {
    // Take them (so they aren't read again) and say once that Optio stops here.
    for (const c of candidates) {
      await recordWriteback({
        ...base,
        event: "follow_up",
        key: `${task.id}:follow_up:${c.id}`,
        status: "skipped",
        details: { author: authorName(c), commentId: c.id, overLimit: true },
      });
    }
    const id = await recordWriteback({
      ...base,
      event: "follow_up_limit",
      key: `${task.id}:follow_up_limit`,
      details: { limit: followUpLimit() },
    });
    if (id) await deliverWriteback(id);
    return false;
  }

  // Take each comment once; another sweep that got here first keeps it.
  const head = candidates[candidates.length - 1];
  const mine: Array<{ rowId: string; c: (typeof candidates)[number] }> = [];
  for (const c of candidates) {
    const isHead = c.id === head.id;
    const rowId = await recordWriteback({
      ...base,
      event: "follow_up",
      key: `${task.id}:follow_up:${c.id}`,
      // Only the newest gets Optio's acknowledgement; the rest are just taken.
      status: isHead ? "pending" : "done",
      details: {
        author: authorName(c),
        commentId: c.id,
        head: isHead,
        ...(isHead ? { answered: false, comments: candidates.map((x) => x.id) } : {}),
      },
    });
    if (rowId) mine.push({ rowId, c });
  }
  if (!mine.length) return false;

  const instructions = mine.map(({ c }) => ({ author: authorName(c), instruction: c.instruction }));
  const prompt = followUpPrompt({
    ticketKey: key,
    source: provider.source,
    comments: instructions,
    prUrl: task.prUrl,
    branch: `optio/task-${task.id}`,
  });
  try {
    await taskService.transitionTask(
      task.id,
      TaskState.QUEUED,
      "ticket_comment",
      `${instructions[instructions.length - 1].author} on ${key}: ${instructions[instructions.length - 1].instruction}`.slice(
        0,
        200,
      ),
    );
  } catch (err) {
    // The work moved on meanwhile (a person resumed it, it merged): give the
    // comments back so a later sweep can take them while it waits again.
    await db.delete(ticketWritebacks).where(
      inArray(
        ticketWritebacks.id,
        mine.map((m) => m.rowId),
      ),
    );
    logger.info(
      { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      "[ticket-follow-ups] The work moved on before its follow-up; the comment waits",
    );
    return false;
  }
  const { taskQueue } = await import("../workers/task-worker.js");
  await taskQueue.add(
    "process-task",
    {
      taskId: task.id,
      resumeSessionId: task.sessionId ?? undefined,
      resumePrompt: prompt,
      restartFromBranch: !!task.prUrl,
    },
    { jobId: `${task.id}-ticket-${head.id}`, attempts: 1 },
  );
  logger.info(
    { taskId: task.id, ticket: key, comments: mine.map((m) => m.c.id) },
    "[ticket-follow-ups] Resumed work from a ticket comment",
  );
  const headRow = mine.find((m) => m.c.id === head.id);
  if (headRow) await deliverWriteback(headRow.rowId);
  return true;
}

/**
 * What the ticket sync does for each enabled provider after its tickets:
 * note when the round trip began for it (once), retry the round trip's
 * unsent writes, then read follow-ups. A provider whose round trip is off
 * only has its unsent writes settled (skipped). Never throws.
 */
export async function ticketRoundTripSweep(
  provider: ProviderRow,
  config: Record<string, unknown>,
): Promise<void> {
  if (!getTicketRoundTrip(provider.source)) return;
  if (!roundTripSettings(provider.config).enabled) {
    try {
      await retryTicketWritebacks(provider.id);
    } catch (err) {
      logger.warn({ err, providerId: provider.id }, "[ticket-writeback] Retry sweep failed");
    }
    return;
  }
  // Without its `since` mark the poll can't tell old conversation from new: no poll then.
  let current: ProviderRow | null = provider;
  try {
    current = await ensureRoundTripSince(provider);
  } catch (err) {
    logger.warn({ err, providerId: provider.id }, "[ticket-follow-ups] Could not note the start");
    if (!roundTripMarks(provider.config).since) current = null;
  }
  try {
    await retryTicketWritebacks(provider.id);
  } catch (err) {
    logger.warn({ err, providerId: provider.id }, "[ticket-writeback] Retry sweep failed");
  }
  if (!current) return;
  try {
    await pollTicketFollowUps(current, config);
  } catch (err) {
    logger.warn({ err, providerId: provider.id }, "[ticket-follow-ups] Follow-up poll failed");
  }
}
