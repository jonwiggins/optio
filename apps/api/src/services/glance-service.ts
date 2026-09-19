/**
 * Server-side "Watch" for the iOS glanceable surfaces: computes the per-user
 * Live Activity frame from Optio Local state and turns producer events
 * (terminal attention, host liveness, task transitions, agent turns) into
 * APNs alerts + Live Activity updates.
 *
 *   docs/design/ios-glanceable-surfaces.md §2a (Watch) and §2i (notifications)
 *   docs/ios-push.md (setup, event → push table)
 *
 * Every hook is fire-and-forget behind `apnsService.isConfigured()`; alerts go
 * through notification-service's per-user preference checks so web push and
 * APNs share one opt-out surface. Attention/queue bookkeeping is in-memory —
 * the API runs a single replica for Optio Local (see local-relay.ts), and the
 * worst case after a restart is one duplicate alert that `apns-collapse-id`
 * folds on the device.
 */
import { and, count, eq, inArray, ne } from "drizzle-orm";
import {
  appleSeconds,
  buildWatchState,
  type WatchItem,
  type WatchState,
  type WatchThen,
  type WatchTileCounts,
} from "@optio/shared";
import type { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import {
  localBlueprints,
  persistentAgentMessages,
  persistentAgents,
  taskConfigs,
  tasks,
  workflows,
  workspaceMembers,
} from "../db/schema.js";
import { logger } from "../logger.js";
import { apnsService } from "./apns-service.js";
import type { AlertInput } from "./apns-payloads.js";
import { shouldNotify, type NotificationEventType } from "./notification-service.js";
import type { LocalHostRow } from "./local-host-service.js";
import type { LocalTerminalRow } from "./local-terminal-service.js";

/** Quiet this long with nothing running or waiting → end the Watch. */
export const WATCH_END_GRACE_MS = 2 * 60_000;

// ── In-memory bookkeeping (single API replica) ──────────────────────────────

/** terminalId → last attention state we pushed for. */
const lastAttention = new Map<string, LocalTerminalRow["attentionState"]>();
/** userId → last computed needs-you count (was the queue empty before this event?). */
const lastNeedsYou = new Map<string, number>();
/** userId → last computed running count (first running terminal → push-to-start). */
const lastRunning = new Map<string, number>();
/** userId → pending end-of-Watch timer. */
const endTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** terminalId → snooze-expiry recompute timer. */
const snoozeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** hostIds we already alerted about going offline (cleared when back online). */
const hostOfflineAlerted = new Set<string>();

export function resetGlanceForTests(): void {
  lastAttention.clear();
  lastNeedsYou.clear();
  lastRunning.clear();
  for (const t of endTimers.values()) clearTimeout(t);
  endTimers.clear();
  for (const t of snoozeTimers.values()) clearTimeout(t);
  snoozeTimers.clear();
  hostOfflineAlerted.clear();
}

// ── Item mapping ────────────────────────────────────────────────────────────

const REASON_COPY: Record<string, string> = {
  stop: "Claude stopped — reply to continue",
  notification: "Waiting on a permission",
  quiet: "Gone quiet — check in",
  exit: "Exited",
};

export function reasonCopy(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REASON_COPY[reason] ?? reason;
}

/** Last non-empty line of the daemon's (already ANSI-stripped) preview. */
export function lastPreviewLine(preview: string | null | undefined): string | null {
  if (!preview) return null;
  const lines = preview.split(/\r?\n/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) return lines[i].slice(0, 120);
  return null;
}

function dirBasename(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** `/Users/me/repos/x` → `~/repos/x` (sessions-feed.ts `shortDir`). */
export function shortDir(dir: string | null | undefined): string | null {
  if (!dir) return null;
  return dir.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
}

/** `https://github.com/o/r.git` → `o/r` (sessions-feed.ts `shortRepo`). */
export function shortRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
}

/** The session row's status word for a terminal (sessions-feed.ts `terminalStatus`). */
export function terminalStatusLabel(row: {
  state: string;
  pendingReason?: string | null;
  attentionState: string | null;
}): string {
  if (row.state === "error") return "error";
  if (row.state === "exited") return "exited";
  if (row.state === "pending")
    return row.pendingReason === "host_offline" ? "host offline" : "pending";
  if (row.attentionState === "needs_you") return "needs you";
  if (row.attentionState === "idle") return "idle";
  return "working";
}

/** The session row's status word for a Repo Task (sessions-feed.ts `taskStatus`). */
export function taskStatusLabel(state: string): string {
  switch (state) {
    case "needs_attention":
      return "needs attention";
    case "pr_opened":
      return "PR open";
    case "completed":
    case "failed":
    case "cancelled":
    case "running":
    case "provisioning":
      return state;
    default:
      return state.replace(/_/g, " ");
  }
}

export function isSnoozed(row: { snoozedUntil: Date | null }, now = Date.now()): boolean {
  return !!row.snoozedUntil && row.snoozedUntil.getTime() > now;
}

/**
 * Terminals that feed the Watch: agent-spec terminals always, plus plain shells
 * once the daemon has observed an agent in them (attention state set by Claude
 * Code hooks or the bell scanner). Mirrors apps/ios/Shared/NeedsYouSnapshot.swift.
 */
function isAgentTerminal(row: LocalTerminalRow): boolean {
  if ((row.spec as { kind?: string } | null)?.kind === "agent") return true;
  return row.attentionState === "working" || row.attentionState === "needs_you";
}

/**
 * A terminal as a Watch row, carrying the session chips the app shows
 * (`SessionRow` in sessions-feed.ts): Where = host · ~/dir, Who = the agent
 * or `terminal`, Then = headless agents exit, everything else waits for you.
 */
export function terminalToWatchItem(
  row: LocalTerminalRow,
  host?: Pick<LocalHostRow, "name"> | null,
): WatchItem {
  const spec = row.spec as { kind?: string; agent?: string; mode?: string } | null;
  const agent = spec?.kind === "agent" ? (spec.agent ?? "claude-code") : "terminal";
  const then: WatchThen =
    spec?.kind === "agent" && spec.mode === "headless" ? "exits" : "waits-for-me";
  const detail = [host?.name ?? null, shortDir(row.dir)].filter(Boolean).join(" · ") || null;
  return {
    kind: "local",
    id: row.id,
    title: row.title,
    mono: dirBasename(row.dir),
    reason: reasonCopy(row.attentionReason),
    preview: lastPreviewLine(row.preview),
    since: appleSeconds(row.updatedAt),
    state: row.attentionState,
    link: `optio://local/${row.id}?compose=1`,
    snoozedUntil: row.snoozedUntil ? appleSeconds(row.snoozedUntil) : null,
    source: "local-terminal",
    when: !row.spawnedBy || row.spawnedBy === "manual" ? "now" : row.spawnedBy,
    where: { target: "machine", detail },
    who: agent,
    then,
    statusLabel: terminalStatusLabel(row),
  };
}

/**
 * A Repo Task as a Watch row (followed tasks; the iOS app builds the same row
 * from `GET /api/tasks/:id` in NeedsYouSnapshot.taskItem). Where = the repo,
 * or the machine for local runs; Then is always `exits` (it opens a PR).
 */
export function taskToWatchItem(task: {
  id: string;
  title: string;
  state: string;
  repoUrl: string;
  repoBranch?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  errorMessage?: string | null;
  agentType?: string | null;
  runTarget?: string | null;
  localDir?: string | null;
  updatedAt: Date;
  metadata?: { taskConfigId?: string | null } | null;
}): WatchItem {
  const local = task.runTarget === "local";
  const reason =
    task.state === "needs_attention" || task.state === "failed"
      ? (task.errorMessage?.slice(0, 80) ?? null)
      : task.state === "pr_opened"
        ? `PR ${task.prNumber ? `#${task.prNumber}` : ""} open`.replace("  ", " ")
        : null;
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    mono:
      task.repoBranch || (task.prNumber ? `#${task.prNumber}` : (shortRepo(task.repoUrl) ?? "")),
    reason,
    preview: null,
    since: appleSeconds(task.updatedAt),
    state: task.state,
    link: `optio://tasks/${task.id}`,
    prUrl: task.prUrl ?? null,
    source: "repo-task",
    when: task.metadata?.taskConfigId ? "on a trigger" : "now",
    where: local
      ? { target: "machine", detail: shortDir(task.localDir) }
      : { target: "pod", detail: shortRepo(task.repoUrl) },
    who: task.agentType ?? "claude-code",
    then: "exits",
    statusLabel: taskStatusLabel(task.state),
  };
}

/** A Persistent Agent as a Watch row: When = messages, Where = pod @slug, Then = persistent. */
export function agentToWatchItem(agent: {
  id: string;
  name: string;
  slug: string;
  state: string;
  agentRuntime?: string | null;
  lastFailureReason?: string | null;
  lastTurnAt?: Date | null;
  updatedAt: Date;
}): WatchItem {
  const statusLabel =
    agent.state === "idle" ||
    agent.state === "paused" ||
    agent.state === "failed" ||
    agent.state === "queued"
      ? agent.state
      : agent.state === "running" || agent.state === "provisioning"
        ? agent.state
        : agent.state === "archived"
          ? "archived"
          : "idle";
  return {
    kind: "agent",
    id: agent.id,
    title: agent.name,
    mono: `@${agent.slug}`,
    reason:
      agent.state === "failed" ? (agent.lastFailureReason?.slice(0, 80) ?? "Turn failed") : null,
    preview: null,
    since: appleSeconds(agent.lastTurnAt ?? agent.updatedAt),
    state: agent.state,
    link: `optio://agents/${agent.id}?compose=1`,
    source: "persistent-agent",
    when: "messages",
    where: { target: "pod", detail: `@${agent.slug}` },
    who: agent.agentRuntime ?? "claude-code",
    then: "waits-for-messages",
    statusLabel,
  };
}

// ── Watch computation ───────────────────────────────────────────────────────

/**
 * The user's Watch frame from Optio Local: needs-you = running agent
 * terminals with attention `needs_you` that aren't snoozed; running = the
 * other running agent terminals; offline = a running terminal's host is
 * unreachable. Followed tasks and agent turns are client-driven for now
 * (docs/design/ios-glanceable-surfaces.md §2b/§2c).
 */
export async function computeWatchState(userId: string, now = new Date()): Promise<WatchState> {
  const [{ listTerminals }, { listHosts }] = await Promise.all([
    import("./local-terminal-service.js"),
    import("./local-host-service.js"),
  ]);
  const [terminals, hosts, tiles] = await Promise.all([
    listTerminals(userId),
    listHosts(userId),
    countSessionTiles(userId).catch((err) => {
      logger.warn({ err, userId }, "glance: session tile counts failed");
      return null;
    }),
  ]);
  const hostById = new Map(hosts.map((h) => [h.id, h]));

  const needsYou: WatchItem[] = [];
  const running: WatchItem[] = [];
  let offlineSince: number | null = null;
  let idleTerminals = 0;

  for (const row of terminals) {
    if (row.state !== "running") continue;
    if (row.attentionState === "idle" && isAgentTerminal(row)) idleTerminals++;
    if (!isAgentTerminal(row)) continue;
    const host = hostById.get(row.hostId);
    if (host && host.state === "offline") {
      const since = appleSeconds(host.updatedAt);
      offlineSince = offlineSince === null ? since : Math.min(offlineSince, since);
    }
    const item = terminalToWatchItem(row, host);
    if (row.attentionState === "needs_you" && !isSnoozed(row, now.getTime())) needsYou.push(item);
    else running.push(item);
  }

  const counts: WatchTileCounts | null = tiles
    ? { ...tiles, waiting: tiles.waiting + idleTerminals }
    : null;
  return buildWatchState({ needsYou, running, offlineSince, counts, now });
}

/**
 * The board tiles the Watch cannot see in its own items (sessions-feed.ts
 * `countSessions`): recurring = enabled blueprints / jobs in the user's
 * workspaces plus their enabled Local automations; agents = persistent agents
 * not archived; waiting = the user's tasks sitting at an open PR (idle
 * terminals are added by the caller, which already has them).
 */
export async function countSessionTiles(userId: string): Promise<WatchTileCounts> {
  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const ws = memberships.map((m) => m.workspaceId);
  const n = async (q: PromiseLike<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);

  const [blueprints, jobs, automations, agents, prOpen] = await Promise.all([
    ws.length === 0
      ? 0
      : n(
          db
            .select({ n: count() })
            .from(taskConfigs)
            .where(and(eq(taskConfigs.enabled, true), inArray(taskConfigs.workspaceId, ws))),
        ),
    ws.length === 0
      ? 0
      : n(
          db
            .select({ n: count() })
            .from(workflows)
            .where(and(eq(workflows.enabled, true), inArray(workflows.workspaceId, ws))),
        ),
    n(
      db
        .select({ n: count() })
        .from(localBlueprints)
        .where(and(eq(localBlueprints.userId, userId), eq(localBlueprints.enabled, true))),
    ),
    ws.length === 0
      ? 0
      : n(
          db
            .select({ n: count() })
            .from(persistentAgents)
            .where(
              and(
                ne(persistentAgents.state, "archived"),
                inArray(persistentAgents.workspaceId, ws),
              ),
            ),
        ),
    n(
      db
        .select({ n: count() })
        .from(tasks)
        .where(and(eq(tasks.createdBy, userId), eq(tasks.state, "pr_opened"))),
    ),
  ]);
  return { waiting: prOpen, recurring: blueprints + jobs + automations, agents };
}

// ── Shared push helpers ─────────────────────────────────────────────────────

async function alert(userId: string, eventType: NotificationEventType, input: AlertInput) {
  if (!(await shouldNotify(userId, eventType))) return;
  await apnsService.sendAlert(userId, input);
}

/**
 * Push the freshest frame to the user's Watch, starting one via push-to-start
 * when the first running terminal appears and no activity is live, or
 * scheduling the end when everything has gone quiet. Reads the previous
 * counts, so callers `remember()` the new state only after this returns.
 */
async function syncWatch(
  userId: string,
  state: WatchState,
  laAlert?: { title: string; body: string } | null,
): Promise<void> {
  const active = state.needsYouCount > 0 || state.runningCount > 0;
  const hasToken = await apnsService.hasWatchToken(userId);

  if (active) {
    const pendingEnd = endTimers.get(userId);
    if (pendingEnd) {
      clearTimeout(pendingEnd);
      endTimers.delete(userId);
    }
    if (hasToken) {
      await apnsService.updateWatch(userId, state, { event: "update", alert: laAlert ?? null });
    } else if ((lastRunning.get(userId) ?? 0) === 0 || laAlert) {
      // First running terminal (or something needing you) and no live Watch:
      // start one if the device gave us a push-to-start token.
      await apnsService.startWatch(userId, state, { alert: laAlert ?? null });
    }
    return;
  }

  if (hasToken && !endTimers.has(userId)) {
    const timer = setTimeout(() => {
      endTimers.delete(userId);
      void computeWatchState(userId)
        .then((latest) => {
          if (latest.needsYouCount > 0 || latest.runningCount > 0) return;
          const done: WatchState = { ...latest, phase: "done", summary: "Quiet." };
          return apnsService.updateWatch(userId, done, { event: "end" });
        })
        .catch((err) => logger.warn({ err, userId }, "glance: ending Watch failed"));
    }, WATCH_END_GRACE_MS);
    timer.unref?.();
    endTimers.set(userId, timer);
  }
}

function remember(userId: string, state: WatchState): void {
  lastNeedsYou.set(userId, state.needsYouCount);
  lastRunning.set(userId, state.runningCount);
}

// ── Hooks: Optio Local ──────────────────────────────────────────────────────

/**
 * Choke point for every terminal state / attention change
 * (local-terminal-service.notifyChanged). Alerts on the transition into
 * `needs_you`; sound only when the queue was empty (§2i).
 */
export async function onLocalTerminalChanged(row: LocalTerminalRow): Promise<void> {
  if (!apnsService.isConfigured()) return;
  const userId = row.userId;
  if (!userId) return; // auth-disabled dev user has no devices

  const prev = lastAttention.get(row.id);
  if (row.state === "exited" || row.state === "error") lastAttention.delete(row.id);
  else lastAttention.set(row.id, row.attentionState);

  const priorQueue = lastNeedsYou.get(userId) ?? 0;
  const state = await computeWatchState(userId);

  const enteredNeedsYou = row.attentionState === "needs_you" && prev !== "needs_you";
  let laAlert: { title: string; body: string } | null = null;

  if (enteredNeedsYou && isAgentTerminal(row) && !isSnoozed(row)) {
    const mono = dirBasename(row.dir);
    const reason = reasonCopy(row.attentionReason) ?? "Needs you";
    const preview = lastPreviewLine(row.preview);
    const body = preview ? `${reason} · ${preview}` : reason;

    if (row.state === "exited" && row.attentionReason === "exit") {
      // Automation finished: review it, but don't ring (§2i "Terminal exit from automation").
      await alert(userId, "local.needs_you", {
        title: `Exited · ${mono}`,
        subtitle: row.title,
        body:
          row.exitCode === 0 ? "Finished — review the result" : `Exit code ${row.exitCode ?? "?"}`,
        category: "LOCAL_EXIT",
        threadId: row.id,
        url: `optio://local/${row.id}`,
        kind: "local",
        id: row.id,
        sound: null,
      });
    } else if (row.state === "running") {
      const queueWasEmpty = priorQueue === 0;
      await alert(userId, "local.needs_you", {
        title: `Needs you · ${mono}`,
        subtitle: row.title,
        body,
        category: "LOCAL_NEEDS_YOU",
        threadId: row.id,
        url: `optio://local/${row.id}?compose=1`,
        kind: "local",
        id: row.id,
        sound: queueWasEmpty ? "default" : null,
        interruptionLevel: "time-sensitive",
      });
      if (queueWasEmpty) laAlert = { title: `Needs you · ${mono}`, body };
    }
  }

  await syncWatch(userId, state, laAlert);
  remember(userId, state);
}

/** Recompute the Watch when a "Later" window closes so the item resurfaces. */
export function scheduleSnoozeExpiry(row: LocalTerminalRow): void {
  const existing = snoozeTimers.get(row.id);
  if (existing) clearTimeout(existing);
  snoozeTimers.delete(row.id);
  if (!row.userId || !row.snoozedUntil || !apnsService.isConfigured()) return;
  const delay = Math.max(0, row.snoozedUntil.getTime() - Date.now());
  const userId = row.userId;
  const timer = setTimeout(() => {
    snoozeTimers.delete(row.id);
    void computeWatchState(userId)
      .then(async (state) => {
        await syncWatch(userId, state);
        remember(userId, state);
      })
      .catch((err) => logger.warn({ err, terminalId: row.id }, "glance: snooze expiry failed"));
  }, delay + 250);
  timer.unref?.();
  snoozeTimers.set(row.id, timer);
}

/** Host went online/offline (local-host-service). Alerts once per outage. */
export async function onLocalHostChanged(
  host: Pick<LocalHostRow, "id" | "userId" | "state" | "name">,
): Promise<void> {
  if (!apnsService.isConfigured()) return;
  const userId = host.userId;
  if (!userId) return;

  const state = await computeWatchState(userId);

  if (host.state === "online") {
    hostOfflineAlerted.delete(host.id);
  } else if (!hostOfflineAlerted.has(host.id)) {
    hostOfflineAlerted.add(host.id);
    // Only worth a ping when something was actually running there.
    if (state.phase === "offline" || state.runningCount > 0 || state.needsYouCount > 0) {
      await alert(userId, "local.host_offline", {
        title: "Laptop unreachable",
        body: `${host.name} stopped responding — running agents may be waiting on you`,
        category: "HOST_OFFLINE",
        threadId: `host-${host.id}`,
        url: "optio://local",
        kind: "host",
        id: host.id,
      });
    }
  }

  await syncWatch(userId, state);
  remember(userId, state);
}

// ── Hooks: Repo Tasks ───────────────────────────────────────────────────────

const TASK_ALERT_STATES: Partial<
  Record<TaskState, { event: NotificationEventType; category: "TASK_ATTENTION" | "TASK_PR_OPENED" }>
> = {
  needs_attention: { event: "task.needs_attention", category: "TASK_ATTENTION" },
  failed: { event: "task.failed", category: "TASK_ATTENTION" },
  pr_opened: { event: "task.pr_opened", category: "TASK_PR_OPENED" },
};

/**
 * Called from taskService.transitionTask. Alerts the creator on
 * needs_attention / failed / pr_opened and refreshes the Watch frame so the
 * island stays current (followed-task items are client-driven for now).
 */
export async function onTaskTransition(
  task: {
    id: string;
    title: string;
    repoUrl: string;
    prUrl?: string | null;
    errorMessage?: string | null;
    createdBy?: string | null;
  },
  toState: TaskState,
): Promise<void> {
  if (!apnsService.isConfigured()) return;
  const userId = task.createdBy;
  if (!userId) return;

  const spec = TASK_ALERT_STATES[toState];
  if (spec) {
    const repoName = task.repoUrl.replace(/^https?:\/\/[^/]+\//, "");
    const titles: Record<string, string> = {
      needs_attention: "Task needs you",
      failed: "Task failed",
      pr_opened: "PR opened",
    };
    const body =
      toState === "failed" && task.errorMessage
        ? `${task.title} — ${task.errorMessage.slice(0, 160)}`
        : `${task.title} — ${repoName}`;
    await alert(userId, spec.event, {
      title: titles[toState] ?? "Task update",
      body,
      category: spec.category,
      threadId: `task-${task.id}`,
      url: `optio://tasks/${task.id}`,
      kind: "task",
      id: task.id,
      interruptionLevel: toState === "pr_opened" ? "active" : "time-sensitive",
      extra: task.prUrl ? { prUrl: task.prUrl } : undefined,
    });
  }

  if (await apnsService.hasWatchToken(userId)) {
    const state = await computeWatchState(userId);
    await syncWatch(userId, state);
    remember(userId, state);
  }
}

// ── Hooks: Persistent Agents ────────────────────────────────────────────────

/**
 * A turn halted. When it drained messages sent by users, each sender gets the
 * reply as a notification in the agent's thread (§2c). Error halts are left to
 * onAgentFailed (only escalations are worth a ping).
 */
export async function onAgentTurnHalted(
  turn: { id: string; agentId: string; haltReason: string | null; summary?: string | null },
  agent: { id: string; name: string; slug: string },
): Promise<void> {
  if (!apnsService.isConfigured()) return;
  if (turn.haltReason === "error" || turn.haltReason === "cancelled") return;

  const senders = await db
    .selectDistinct({ senderId: persistentAgentMessages.senderId })
    .from(persistentAgentMessages)
    .where(
      and(
        eq(persistentAgentMessages.turnId, turn.id),
        eq(persistentAgentMessages.senderType, "user"),
      ),
    );
  const userIds = senders.map((s) => s.senderId).filter((id): id is string => !!id);
  if (userIds.length === 0) return;

  const body = (turn.summary ?? "").trim().slice(0, 200) || "Finished the turn — open to read";
  await Promise.allSettled(
    userIds.map((userId) =>
      alert(userId, "agent.turn_completed", {
        title: agent.name,
        body,
        category: "AGENT_REPLY",
        threadId: `agent-${agent.id}`,
        url: `optio://agents/${agent.id}?compose=1`,
        kind: "agent",
        id: agent.id,
        collapseId: `agent-${agent.id}-${turn.id}`,
      }),
    ),
  );
}

/** Agent hit its consecutive-failure limit (state → failed). */
export async function onAgentFailed(
  agent: { id: string; name: string; createdBy: string | null; lastFailureReason?: string | null },
  reason?: string | null,
): Promise<void> {
  if (!apnsService.isConfigured()) return;
  const userId = agent.createdBy;
  if (!userId) return;
  const why = (reason ?? agent.lastFailureReason ?? "").trim().slice(0, 160);
  await alert(userId, "agent.failed", {
    title: `${agent.name} stopped`,
    body: why ? `Too many failed turns — ${why}` : "Too many failed turns — resume when ready",
    category: "AGENT_FAILED",
    threadId: `agent-${agent.id}`,
    url: `optio://agents/${agent.id}`,
    kind: "agent",
    id: agent.id,
    interruptionLevel: "time-sensitive",
  });
}
