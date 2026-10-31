import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  notificationPreferences,
  users,
  workDefinitions,
  workRuns,
  workspaceMembers,
  workspaces,
  type NotifyChannelPrefs,
  type NotifyDigestPrefs,
} from "../../db/schema.js";
import { logger } from "../../logger.js";
import { visibleOwner } from "../ownership.js";
import { hookForPerson } from "./chat-hooks.js";
import type { DigestItem, DigestSection } from "./chat-messages.js";
import { jobFailureNotNews } from "./dispatch.js";
import { emailAvailable } from "./email.js";
import { isEmailAddress } from "./mime.js";
import { deliver } from "./outbox.js";
import { digestOf } from "./preferences.js";
import { actorFor } from "./recipients.js";
import { publicWebUrl, repoName, workPath } from "./templates.js";

/**
 * The daily digest (docs/notifications.md "The daily digest"): once a day,
 * at the hour a person picks in their time zone (Settings → Notifications →
 * Daily digest), one message with what waits for them (merge requests to
 * review, work that needs them), what failed and what merged since their
 * last digest, by email, on their own chat hook, or both. Nothing to say,
 * nothing sent.
 *
 * "Theirs" is what they would be told about one event at a time
 * (recipients.ts): work they own and the organization's work they started,
 * only what they may still see (ownership.ts `visibleOwner`), in each
 * workspace they are still a member of. A failure shows only its first
 * line, as the email about it does. Email goes only to a verified address,
 * and a disabled account gets no digest.
 *
 * The housekeeping tick (workers/notify-worker.ts, every five minutes) sends
 * a digest that is due: from its hour until four hours after (so a restart
 * at the wrong moment doesn't skip a day), once per local day — claimed in
 * `notification_preferences.digest_sent_on`, so several API instances never
 * send it twice.
 */

/** How long after its hour a digest may still go out. */
const DUE_WINDOW_MINUTES = 4 * 60;
/** The longest stretch one digest covers (after days without one). */
const MAX_SPAN_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
/** Lines per section. */
const SHOWN = 15;
/** Rows read per section and workspace. */
const READ = 100;

/** The local date (`2026-10-24`), hour and minute of `at` in `timeZone`. */
export function localParts(
  at: Date,
  timeZone: string,
): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
  };
}

function previousDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * The local day a digest is due for at `now`, or null when it isn't due:
 * from the person's hour until four hours after (a window that crosses
 * midnight counts for the day it started on).
 */
export function digestDueDay(prefs: NotifyDigestPrefs, now: Date): string | null {
  if (!prefs.enabled) return null;
  const { date, hour, minute } = localParts(now, prefs.timeZone);
  const minutes = hour * 60 + minute;
  const after = (minutes - prefs.hour * 60 + 1440) % 1440;
  if (after >= DUE_WINDOW_MINUTES) return null;
  return after > minutes ? previousDay(date) : date;
}

interface DigestRow {
  id: string;
  kind: "repo" | "standalone";
  title: string | null;
  workName: string | null;
  workId: string | null;
  repoUrl: string | null;
  prUrl: string | null;
  state: string;
  errorMessage: string | null;
  retryCount: number;
  recoveryRequired: boolean;
  maxRetries: number | null;
  at: Date;
}

export interface Digest {
  title: string;
  sections: DigestSection[];
  /** Nothing waits, failed or merged. */
  empty: boolean;
  /** Counts per section, for the subject and the API. */
  counts: { waiting: number; failed: number; merged: number };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function itemOf(row: DigestRow, detail: string | null, workspaceName: string | null): DigestItem {
  const name = clip(oneLine(row.title || row.workName || "Untitled work"), 120);
  const parts = [workspaceName, detail].filter((p): p is string => !!p);
  return {
    name,
    link: workPath({ id: row.id, kind: row.kind, workId: row.workId }),
    detail: parts.length ? parts.join(" · ") : null,
  };
}

/**
 * What `userId`'s digest says about [since, until): per workspace they are
 * a member of, the work that is theirs and that they may see.
 */
export async function buildDigest(
  userId: string,
  window: { since: Date; until: Date; timeZone: string },
): Promise<Digest> {
  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
  const named = memberships.length > 1;

  const waiting: { items: DigestItem[]; total: number } = { items: [], total: 0 };
  const failed: { items: DigestItem[]; total: number } = { items: [], total: 0 };
  const merged: { items: DigestItem[]; total: number } = { items: [], total: 0 };

  for (const m of memberships) {
    const actor = await actorFor(userId, m.workspaceId);
    if (!actor) continue;
    const mine = or(
      eq(workRuns.ownerUserId, userId),
      and(isNull(workRuns.ownerUserId), eq(workRuns.createdBy, userId)),
    );
    const visible = visibleOwner(workRuns.ownerUserId, actor);
    const finishedAt = sql<Date>`coalesce(${workRuns.completedAt}, ${workRuns.updatedAt})`;
    const read = (where: SQL | undefined, orderAt: SQL<Date> | typeof workRuns.updatedAt) =>
      db
        .select({
          id: workRuns.id,
          kind: workRuns.kind,
          title: workRuns.title,
          workName: workDefinitions.name,
          workId: workRuns.workId,
          repoUrl: workRuns.repoUrl,
          prUrl: workRuns.prUrl,
          state: workRuns.state,
          errorMessage: workRuns.errorMessage,
          retryCount: workRuns.retryCount,
          recoveryRequired: workRuns.recoveryRequired,
          maxRetries: workDefinitions.maxRetries,
          at: orderAt,
        })
        .from(workRuns)
        .leftJoin(workDefinitions, eq(workDefinitions.id, workRuns.workId))
        .where(
          and(
            eq(workRuns.workspaceId, m.workspaceId),
            // A code-review subtask's state is its parent's business.
            ne(workRuns.taskType, "review"),
            mine,
            ...(visible ? [visible] : []),
            where,
          ),
        )
        .orderBy(desc(orderAt))
        .limit(READ) as unknown as Promise<DigestRow[]>;

    const wsName = named ? m.name : null;
    const w = await read(
      inArray(workRuns.state, ["pr_opened", "needs_attention"]),
      workRuns.updatedAt,
    );
    waiting.total += w.length;
    for (const row of w) {
      const what =
        row.state === "pr_opened" ? "Merge request waiting for you" : "Needs your attention";
      waiting.items.push(
        itemOf(row, [what, repoName(row.repoUrl)].filter(Boolean).join(" · "), wsName),
      );
    }

    const inWindow = and(
      sql`${finishedAt} >= ${window.since.toISOString()}::timestamptz`,
      sql`${finishedAt} < ${window.until.toISOString()}::timestamptz`,
    );
    const f = (await read(and(eq(workRuns.state, "failed"), inWindow), finishedAt)).filter(
      // A Job run's failure counts once, at its last try; a cancel isn't one.
      (row) => row.kind !== "standalone" || !jobFailureNotNews(row),
    );
    failed.total += f.length;
    for (const row of f) {
      // The first line only: stderr and tool output after it stay in Optio.
      const first = row.errorMessage?.trim().split(/\r?\n/, 1)[0];
      const why = first ? clip(oneLine(first), 100) : null;
      const where = row.kind === "standalone" ? "Job run" : repoName(row.repoUrl);
      failed.items.push(itemOf(row, [where, why].filter(Boolean).join(" · "), wsName));
    }

    const g = await read(
      and(eq(workRuns.state, "completed"), eq(workRuns.prState, "merged"), inWindow),
      finishedAt,
    );
    merged.total += g.length;
    for (const row of g) merged.items.push(itemOf(row, repoName(row.repoUrl), wsName));
  }

  const section = (title: string, s: { items: DigestItem[]; total: number }): DigestSection => ({
    title,
    items: s.items.slice(0, SHOWN),
    more: Math.max(0, s.total - Math.min(SHOWN, s.items.length)),
  });
  const sections = [
    section("Waiting for you", waiting),
    section("Failed", failed),
    section("Merged", merged),
  ].filter((s) => s.items.length > 0);
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: window.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(window.until);
  return {
    title: `Your Optio digest for ${day}`,
    sections,
    empty: sections.length === 0,
    counts: { waiting: waiting.total, failed: failed.total, merged: merged.total },
  };
}

/** The digest as an email: plain text, links under PUBLIC_URL. */
export function renderDigestEmail(
  digest: Digest,
  since: Date,
  timeZone: string,
  base: string | null = publicWebUrl(),
): { subject: string; text: string } {
  const c = digest.counts;
  const counts = [
    c.waiting ? `${c.waiting} waiting for you` : null,
    c.failed ? `${c.failed} failed` : null,
    c.merged ? `${c.merged} merged` : null,
  ].filter(Boolean);
  const sinceText = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(since);
  const lines = [
    digest.empty
      ? "Nothing waits for you, and nothing of yours failed or merged."
      : `What happened in Optio since ${sinceText}.`,
  ];
  for (const s of digest.sections) {
    lines.push("", `${s.title} (${s.items.length + s.more})`);
    for (const item of s.items) {
      lines.push(`  - ${item.name}${item.detail ? ` · ${item.detail}` : ""}`);
      if (base && item.link) lines.push(`    ${base}${item.link}`);
    }
    if (s.more > 0) lines.push(`  - and ${s.more} more`);
  }
  lines.push(
    "",
    "-- ",
    "You get this digest because you turned it on.",
    base
      ? `Change its time or turn it off: ${base}/settings#notifications`
      : "Change its time or turn it off under Settings → Notifications.",
    "",
  );
  return {
    subject: `[Optio] ${digest.title.replace(/^Your Optio digest/, "Your digest")}${
      counts.length ? `: ${counts.join(", ")}` : ""
    }`,
    text: lines.join("\n"),
  };
}

export interface DigestSendResult {
  /** The channels it went to. */
  via: Array<"email" | "chat">;
  empty: boolean;
  counts: Digest["counts"];
  /** Why it went nowhere. */
  error?: string;
}

/**
 * Build and send one person's digest over the channels they picked. An
 * empty digest goes out only when `sendEmpty` (the "Send me one now" button).
 */
export async function sendDigest(
  userId: string,
  prefs: NotifyDigestPrefs,
  window: { since: Date; until: Date },
  opts: { sendEmpty?: boolean } = {},
): Promise<DigestSendResult> {
  const digest = await buildDigest(userId, { ...window, timeZone: prefs.timeZone });
  const out: DigestSendResult = { via: [], empty: digest.empty, counts: digest.counts };
  if (digest.empty && !opts.sendEmpty) return out;
  const errors: string[] = [];
  const base = publicWebUrl();
  if (prefs.via === "email" || prefs.via === "both") {
    const [me] = await db
      .select({
        email: users.email,
        emailVerified: users.emailVerified,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!(await emailAvailable())) errors.push("Email isn't set up on this Optio");
    else if (!me || me.disabledAt) errors.push("The account is disabled");
    else if (!me.emailVerified || !isEmailAddress(me.email))
      errors.push("Your account has no verified email address");
    else {
      const email = renderDigestEmail(digest, window.since, prefs.timeZone, base);
      const r = await deliver({
        channel: "email",
        kind: "digest",
        userId,
        email: {
          to: [me.email],
          subject: email.subject,
          text: email.text,
          headers: { "X-Optio-Event": "digest" },
        },
      });
      if (r.ok) out.via.push("email");
      else errors.push(r.error);
    }
  }
  if (prefs.via === "chat" || prefs.via === "both") {
    // Only an enabled person's hook that is on (chat-hooks.ts).
    const hook = await hookForPerson(userId);
    if (!hook) errors.push("You have no chat hook (or it is off)");
    else {
      const r = await deliver({
        channel: "chat",
        kind: "digest",
        userId,
        message: { type: "digest", title: digest.title, sections: digest.sections, link: "/" },
      });
      if (r.ok) out.via.push("chat");
      else errors.push(r.error);
    }
  }
  if (!out.via.length && errors.length) out.error = errors.join("; ");
  return out;
}

/**
 * The tick: every person whose digest is due now gets it, once per local
 * day (claimed first, so another API instance's tick skips them). Never
 * throws for one person's failure.
 */
export async function runDigestTick(now = new Date()): Promise<{ due: number; sent: number }> {
  const rows = await db
    .select({
      userId: notificationPreferences.userId,
      channels: notificationPreferences.channels,
      sentOn: notificationPreferences.digestSentOn,
      sentAt: notificationPreferences.digestSentAt,
    })
    .from(notificationPreferences)
    .innerJoin(users, eq(users.id, notificationPreferences.userId))
    .where(
      and(
        sql`${notificationPreferences.channels} -> 'digest' ->> 'enabled' = 'true'`,
        isNull(users.disabledAt),
      ),
    );
  let due = 0;
  let sent = 0;
  for (const row of rows) {
    const prefs = digestOf((row.channels as NotifyChannelPrefs | null)?.digest);
    const day = digestDueDay(prefs, now);
    if (!day || row.sentOn === day) continue;
    const claimed = await db
      .update(notificationPreferences)
      .set({ digestSentOn: day, digestSentAt: now })
      .where(
        and(
          eq(notificationPreferences.userId, row.userId),
          sql`${notificationPreferences.digestSentOn} IS DISTINCT FROM ${day}`,
        ),
      )
      .returning({ userId: notificationPreferences.userId });
    if (!claimed.length) continue;
    due++;
    const since = new Date(
      Math.max(row.sentAt?.getTime() ?? now.getTime() - DAY_MS, now.getTime() - MAX_SPAN_MS),
    );
    try {
      const r = await sendDigest(row.userId, prefs, { since, until: now });
      if (r.via.length) sent++;
      else if (r.error)
        logger.info({ userId: row.userId, error: r.error }, "notify: digest not sent");
    } catch (err) {
      logger.warn({ err, userId: row.userId }, "notify: digest failed");
    }
  }
  return { due, sent };
}
