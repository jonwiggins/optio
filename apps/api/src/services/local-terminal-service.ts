/**
 * Optio Local terminals: DB state machine + spawn orchestration over the
 * daemon relay. See docs/optio-local.md.
 *
 * State machine: pending → launching → running → exited | error.
 * The daemon is authoritative for the process; this service is authoritative
 * for the DB row and publishes content-free nudges + browser status frames on
 * every transition.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  LOCAL_DEFAULT_COLS,
  LOCAL_DEFAULT_ROWS,
  LOCAL_LAUNCH_TIMEOUT_MS,
  LOCAL_TRANSCRIPT_DETAIL_MAX,
  LOCAL_TRANSCRIPT_MAX_ENTRIES,
  LOCAL_TRANSCRIPT_TEXT_MAX,
  MAX_WORK_LINKS,
  type WorkLink,
  type LocalTranscriptEntry,
  type LocalTranscriptKind,
  type LocalTranscriptRole,
  type LocalAttentionState,
  type LocalDaemonTerminalSync,
  type LocalSpawnSource,
  type LocalTerminalSpec,
  type LocalTerminalUsage,
} from "@optio/shared";
import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import { localTerminalSnapshots, localTerminalTranscripts, localTerminals } from "../db/schema.js";
import { logger } from "../logger.js";
import { publishLocalChanged } from "./event-bus.js";
import { isAuthDisabled } from "./oauth/index.js";
import * as relay from "./local-relay.js";
import { getHost, isDirAllowed, type LocalHostRow } from "./local-host-service.js";

export type LocalTerminalRow = typeof localTerminals.$inferSelect;

const AGENT_BINS: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor-agent",
  gemini: "gemini",
  opencode: "opencode",
};

function ownedBy(userId: string | null | undefined) {
  return userId ? eq(localTerminals.userId, userId) : isNull(localTerminals.userId);
}

export function canAccessTerminal(
  terminal: LocalTerminalRow,
  userId: string | null | undefined,
): boolean {
  if (terminal.userId) return terminal.userId === (userId ?? null);
  return isAuthDisabled();
}

/** Human-readable rendering of a spec for list views. Never re-executed. */
/** Branch prefix for "new branch" sessions opened from the New session form. */
export const LOCAL_SESSION_BRANCH_PREFIX = "optio/session-";

/**
 * Wrap an agent prompt with "work on a branch, open a PR" instructions — the
 * local counterpart of the cluster pipeline's branch + PR wrapper, for a
 * session that runs in the owner's own checkout. A blank prompt becomes just
 * the instructions, so an interactive session opened on a new branch starts
 * by branching.
 */
export function withBranchInstructions(
  prompt: string,
  opts: { baseBranch: string; branch: string; dir: string },
): string {
  const base = opts.baseBranch.trim() || "main";
  const lines = [
    `You are working in the local checkout at ${opts.dir}.`,
    `Work on a branch, never directly on \`${base}\`: create \`${opts.branch}\` from an up-to-date \`${base}\`, commit your changes there, push it, and open a pull request against \`${base}\` (for example with \`gh pr create\`) with a clear title and description.`,
    "Print the pull request URL when you are done.",
  ];
  const body = prompt.trim();
  return body ? `${body}\n\n---\n${lines.join("\n")}` : lines.join("\n");
}

export function describeSpec(spec: LocalTerminalSpec): string | null {
  switch (spec.kind) {
    case "shell":
      return null;
    case "command":
      return spec.command;
    case "agent": {
      const bin = AGENT_BINS[spec.agent] ?? spec.agent;
      if (spec.resumeSessionId) return `${bin} --resume ${spec.resumeSessionId.slice(0, 8)}…`;
      const flag = spec.mode === "headless" ? " -p" : "";
      if (!spec.prompt) return `${bin}${flag}`;
      const short = spec.prompt.length > 120 ? `${spec.prompt.slice(0, 117)}...` : spec.prompt;
      return `${bin}${flag} "${short.replaceAll("\n", " ")}"`;
    }
  }
}

async function notifyChanged(row: LocalTerminalRow): Promise<void> {
  relay.notifyBrowsers(row.id, {
    type: "status",
    state: row.state,
    attentionState: row.attentionState,
  });
  await publishLocalChanged({
    terminalId: row.id,
    hostId: row.hostId,
    userId: row.userId,
  }).catch((err) => logger.warn({ err }, "local: failed to publish change event"));
  // A terminal that executes a Job run / Repo Task drives that run's state
  // (queued → running → completed/failed, PR detection, cost). Awaited so the
  // daemon's frame order (started, then exit) is the run's transition order.
  // Dynamic import: local-run-service imports this module.
  if (row.workflowRunId || row.taskId) {
    await import("./local-run-service.js")
      .then(({ syncLinkedRun }) => syncLinkedRun(row))
      .catch((err) => logger.warn({ err, terminalId: row.id }, "local: run sync failed"));
  }
  // iOS + Android: the Watch + needs-you alerts (no-op unless APNs or FCM is configured).
  import("./glance-service.js")
    .then(({ onLocalTerminalChanged }) => onLocalTerminalChanged(row))
    .catch((err) => logger.warn({ err, terminalId: row.id }, "local: glance hook failed"));
}

/** True while a "Later" window is open on the terminal. */
export function isTerminalSnoozed(row: LocalTerminalRow, now = Date.now()): boolean {
  return !!row.snoozedUntil && row.snoozedUntil.getTime() > now;
}

/**
 * "Later": drop the terminal out of the needs-you queue (Watch, widgets,
 * push) for `minutes`. Attention state is untouched — the daemon still owns
 * it — so the item resurfaces when the window closes.
 */
export async function snoozeTerminal(
  row: LocalTerminalRow,
  minutes: number,
): Promise<LocalTerminalRow> {
  const snoozedUntil = new Date(Date.now() + Math.round(minutes * 60_000));
  const updated = await updateTerminal(row.id, { snoozedUntil });
  if (!updated) throw new Error("Terminal not found");
  import("./glance-service.js")
    .then(({ scheduleSnoozeExpiry }) => scheduleSnoozeExpiry(updated))
    .catch(() => {});
  return updated;
}

export async function unsnoozeTerminal(row: LocalTerminalRow): Promise<LocalTerminalRow> {
  const updated = await updateTerminal(row.id, { snoozedUntil: null });
  if (!updated) throw new Error("Terminal not found");
  import("./glance-service.js")
    .then(({ scheduleSnoozeExpiry }) => scheduleSnoozeExpiry(updated))
    .catch(() => {});
  return updated;
}

async function updateTerminal(
  id: string,
  set: Partial<typeof localTerminals.$inferInsert>,
): Promise<LocalTerminalRow | null> {
  const [row] = await db
    .update(localTerminals)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(localTerminals.id, id))
    .returning();
  if (row) await notifyChanged(row);
  return row ?? null;
}

/**
 * Compare-and-swap state transition. The UPDATE only lands when the row is
 * still in one of `from` (and, for daemon-originated calls, still owned by
 * `hostId`) — so two concurrent writers can't clobber each other's result.
 * Daemon frames are handled without a global lock (ws/local-daemon.ts), and
 * the sweeper/REST paths race with them, so every daemon-driven transition
 * goes through here. A zero-row result means the CAS lost — the caller treats
 * it as a no-op. Returns null on a lost race.
 */
async function transitionTerminal(
  id: string,
  from: LocalTerminalRow["state"][],
  set: Partial<typeof localTerminals.$inferInsert>,
  opts: { hostId?: string } = {},
): Promise<LocalTerminalRow | null> {
  const conds = [eq(localTerminals.id, id), inArray(localTerminals.state, from)];
  if (opts.hostId) conds.push(eq(localTerminals.hostId, opts.hostId));
  const [row] = await db
    .update(localTerminals)
    .set({ ...set, updatedAt: new Date() })
    .where(and(...conds))
    .returning();
  if (row) await notifyChanged(row);
  return row ?? null;
}

export interface CreateTerminalInput {
  host: LocalHostRow;
  userId: string | null;
  workspaceId: string | null;
  dir: string;
  spec: LocalTerminalSpec;
  title?: string;
  spawnedBy?: LocalSpawnSource;
  blueprintId?: string;
  triggerId?: string;
  ticket?: { source: string; externalId: string; url?: string };
  /** "hold" keeps the terminal pending until a human starts it. */
  hold?: boolean;
  /**
   * Pre-assigned row id. local-run-service claims the id on the run row
   * (CAS) before the terminal exists, so two concurrent dispatches can never
   * spawn two terminals for one run.
   */
  id?: string;
  /** Job run this terminal executes (spawnedBy = "job"). */
  workflowRunId?: string;
  /** Repo Task this terminal executes (spawnedBy = "task"). */
  taskId?: string;
}

/**
 * Create a terminal row and (unless held) ask the daemon to spawn it. When
 * the host is offline the terminal parks in `pending`/`host_offline` and is
 * flushed on the daemon's next hello.
 */
export async function createTerminal(input: CreateTerminalInput): Promise<LocalTerminalRow> {
  if (!isDirAllowed(input.host, input.dir)) {
    throw new Error(`Directory not in the host's allowlist: ${input.dir}`);
  }
  let spec = input.spec;
  if (spec.kind === "agent" && !AGENT_BINS[spec.agent]) {
    throw new Error(`Unknown agent kind: ${spec.agent}`);
  }
  // "New branch that becomes a PR": the id is fixed up front so the branch
  // name in the instructions matches the row.
  const id = input.id ?? randomUUID();
  if (spec.kind === "agent" && spec.baseBranch && !spec.resumeSessionId) {
    spec = {
      ...spec,
      prompt: withBranchInstructions(spec.prompt ?? "", {
        baseBranch: spec.baseBranch,
        branch: `${LOCAL_SESSION_BRANCH_PREFIX}${id.slice(0, 8)}`,
        dir: input.dir,
      }),
    };
  }

  const title =
    input.title?.trim() ||
    (spec.kind === "agent"
      ? `${spec.agent} · ${lastPathSegment(input.dir)}`
      : spec.kind === "command"
        ? `${spec.command.slice(0, 40)} · ${lastPathSegment(input.dir)}`
        : `shell · ${lastPathSegment(input.dir)}`);

  const [row] = await db
    .insert(localTerminals)
    .values({
      id,
      hostId: input.host.id,
      userId: input.userId,
      workspaceId: input.workspaceId,
      title,
      dir: input.dir,
      command: describeSpec(spec),
      spec: spec as unknown as Record<string, unknown>,
      state: "pending",
      pendingReason: input.hold ? "hold" : "host_offline",
      attentionState: "idle",
      spawnedBy: input.spawnedBy ?? "manual",
      blueprintId: input.blueprintId,
      triggerId: input.triggerId,
      workflowRunId: input.workflowRunId,
      taskId: input.taskId,
      ticketSource: input.ticket?.source,
      ticketExternalId: input.ticket?.externalId,
      ticketUrl: input.ticket?.url,
    })
    .returning();

  if (input.hold) {
    await notifyChanged(row);
    return row;
  }
  return (await trySpawn(row)) ?? row;
}

/**
 * Send the spawn to the daemon; parks in pending/host_offline when unreachable.
 *
 * The row is claimed (pending → launching) under CAS *before* the spawn frame
 * goes out, so two concurrent callers — a fresh createTerminal and the parked
 * flush on a daemon hello — can never both send a spawn for the same row.
 * Returns the current row when someone else already claimed it.
 */
async function trySpawn(row: LocalTerminalRow): Promise<LocalTerminalRow | null> {
  if (!relay.isHostOnline(row.hostId)) {
    return updateTerminal(row.id, { state: "pending", pendingReason: "host_offline" });
  }
  const claimed = await transitionTerminal(row.id, ["pending"], {
    state: "launching",
    pendingReason: null,
  });
  if (!claimed) return getTerminal(row.id);
  const sent = relay.sendToHost(row.hostId, {
    type: "spawn",
    terminalId: row.id,
    dir: row.dir,
    cols: LOCAL_DEFAULT_COLS,
    rows: LOCAL_DEFAULT_ROWS,
    spec: row.spec as unknown as LocalTerminalSpec,
  });
  if (sent) return claimed;
  // The daemon dropped between the liveness check and the send: un-claim.
  return transitionTerminal(row.id, ["launching"], {
    state: "pending",
    pendingReason: "host_offline",
  });
}

/** Start a pending (held or parked) terminal. */
export async function startTerminal(row: LocalTerminalRow): Promise<LocalTerminalRow> {
  if (row.state !== "pending") throw new Error(`Terminal is ${row.state}, not pending`);
  const updated = await trySpawn(row);
  if (!updated || updated.state === "pending") {
    throw new Error("Host is offline — the terminal will stay pending until it reconnects");
  }
  return updated;
}

export async function killTerminal(row: LocalTerminalRow, signal?: string): Promise<void> {
  if (row.state === "pending") {
    await updateTerminal(row.id, {
      state: "error",
      errorMessage: "Cancelled before start",
      endedAt: new Date(),
    });
    return;
  }
  if (row.state !== "running" && row.state !== "launching") {
    throw new Error(`Terminal is ${row.state}`);
  }
  const sent = relay.sendToHost(row.hostId, {
    type: "kill",
    terminalId: row.id,
    signal,
  });
  if (!sent) {
    // The host is unreachable (the daemon can't be asked to kill the PTY).
    // Rather than stranding the row as a live-looking terminal that can be
    // neither viewed nor deleted, force it to a terminal state — the PTY dies
    // with the daemon anyway, and a later reconcileHello agrees.
    await updateTerminal(row.id, {
      state: "exited",
      errorMessage: "Killed while the host was offline",
      endedAt: new Date(),
      attentionState: "idle",
      attentionReason: null,
    });
  }
}

export async function getTerminal(id: string): Promise<LocalTerminalRow | null> {
  const [row] = await db.select().from(localTerminals).where(eq(localTerminals.id, id));
  return row ?? null;
}

export async function listTerminals(
  userId: string | null | undefined,
  filters: { hostId?: string; state?: LocalTerminalRow["state"] } = {},
  limit = 200,
): Promise<LocalTerminalRow[]> {
  const conds = [ownedBy(userId)];
  if (filters.hostId) conds.push(eq(localTerminals.hostId, filters.hostId));
  if (filters.state) conds.push(eq(localTerminals.state, filters.state));
  return db
    .select()
    .from(localTerminals)
    .where(and(...conds))
    .orderBy(desc(localTerminals.createdAt))
    .limit(limit);
}

export async function deleteTerminal(row: LocalTerminalRow): Promise<void> {
  if (row.state === "running" || row.state === "launching") {
    throw new Error("Kill the terminal before deleting it");
  }
  await db.delete(localTerminals).where(eq(localTerminals.id, row.id));
  await publishLocalChanged({
    terminalId: row.id,
    hostId: row.hostId,
    userId: row.userId,
  }).catch(() => {});
}

// ── Daemon event handlers (called from ws/local-daemon.ts) ─────────────────
//
// Every handler takes the authenticated `hostId` of the daemon that sent the
// frame and scopes its write to it, so a daemon can only ever mutate its own
// host's terminals (terminal ids are not secret — they ride the shared events
// channel). All transitions are CAS-guarded so concurrent daemon frames, the
// sweeper, and REST control can't clobber each other.

export async function handleStarted(hostId: string, terminalId: string): Promise<void> {
  const row = await getTerminal(terminalId);
  if (!row || row.hostId !== hostId) return;
  const spec = row.spec as unknown as LocalTerminalSpec;
  await transitionTerminal(
    terminalId,
    ["launching"],
    {
      state: "running",
      startedAt: new Date(),
      attentionState: spec.kind === "shell" ? "idle" : "working",
      attentionReason: null,
      errorMessage: null,
    },
    { hostId },
  );
}

export async function handleSpawnError(
  hostId: string,
  terminalId: string,
  message: string,
): Promise<void> {
  await transitionTerminal(
    terminalId,
    ["pending", "launching", "running"],
    {
      state: "error",
      errorMessage: message.slice(0, 2000),
      endedAt: new Date(),
    },
    { hostId },
  );
}

export async function handleExit(
  hostId: string,
  terminalId: string,
  exitCode: number | null,
): Promise<void> {
  const row = await getTerminal(terminalId);
  if (!row || row.hostId !== hostId) return;
  const updated = await transitionTerminal(
    terminalId,
    ["running", "launching"],
    {
      state: "exited",
      exitCode,
      endedAt: new Date(),
      ...exitAttention(row, exitCode),
    },
    { hostId },
  );
  if (updated) {
    // Viewers streaming it: the exit, then the grid its final screen was
    // recorded at, so they pin it the way a viewer opening the exited
    // terminal would ("Recorded screen", no "Use this screen"). A viewer
    // whose attach is still pending gets all of that from the replay instead.
    relay.notifyBrowsers(terminalId, { type: "exit", exitCode }, { pending: false });
    const grid = await getSnapshotGrid(terminalId);
    if (grid) relay.notifyBrowsers(terminalId, { type: "size", ...grid }, { pending: false });
  }
}

const isDeadState = (state: string) => state === "exited" || state === "error";

/** How long a refused attach waits for its terminal's exit to land. */
const ATTACH_REFUSED_EXIT_GRACE_MS = 3_000;
const ATTACH_REFUSED_POLL_MS = 100;

/**
 * Send one viewer a finished terminal's recorded screen: the grid it was
 * drawn at, the screen bytes, then `exit` (preceded by a `status` when
 * `withStatus`) — the order a viewer lays it out and pins it in.
 */
export async function replayRecordedScreen(
  socket: relay.RelaySocket,
  row: LocalTerminalRow,
  opts: { withStatus: boolean },
): Promise<void> {
  if (opts.withStatus) {
    relay.sendToViewer(socket, {
      type: "status",
      state: row.state,
      attentionState: row.attentionState,
    });
  }
  const snapshot = await getSnapshot(row.id);
  if (snapshot) {
    relay.sendToViewer(socket, { type: "size", cols: snapshot.cols, rows: snapshot.rows });
    relay.sendToViewer(socket, snapshot.data);
  }
  relay.sendToViewer(socket, { type: "exit", exitCode: row.exitCode });
}

/**
 * The daemon refused a viewer's attach: it has no PTY for the terminal.
 * Usually the process already finished — a command like `echo hi` is done
 * before its pane opens — and the daemon's snapshot + exit reach us around
 * the same time (a daemon that forgets the terminal before sending them
 * answers the attach first). So once the row is dead, the viewer gets the
 * recorded screen, as it would opening the exited terminal fresh, instead of
 * "Unknown terminal" over a finished session. Only a terminal that stays
 * running past the grace gets the daemon's error.
 *
 * Must run off the daemon socket's frame queue: the exit it may wait for
 * arrives on that same socket.
 */
export async function handleAttachError(attachId: string, message: string): Promise<void> {
  const pending = relay.takePendingAttach(attachId);
  if (!pending) return;
  const deadline = Date.now() + ATTACH_REFUSED_EXIT_GRACE_MS;
  for (let waited = false; ; waited = true) {
    const row = await getTerminal(pending.terminalId);
    if (row && isDeadState(row.state)) {
      // Dead already: the exit landed while this attach was pending, so the
      // viewer heard the state change then. Died while we waited: tell it now.
      await replayRecordedScreen(pending.socket, row, { withStatus: waited });
      return;
    }
    if (!row || pending.socket.readyState !== 1 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, ATTACH_REFUSED_POLL_MS));
  }
  relay.sendToViewer(pending.socket, { type: "error", message });
}

/**
 * Attention after exit. Automation results land in the "needs you" queue for
 * review (a headless run that finished cleanly is `done`, anything else is
 * `exit`); a shell you typed `exit` into does not demand attention.
 */
export function exitAttention(
  row: Pick<LocalTerminalRow, "spawnedBy" | "spec">,
  exitCode: number | null,
): { attentionState: LocalAttentionState; attentionReason: string | null } {
  if (row.spawnedBy === "manual" || row.spawnedBy === "resume") {
    return { attentionState: "idle", attentionReason: null };
  }
  const spec = row.spec as unknown as LocalTerminalSpec;
  const headless = spec.kind === "agent" && spec.mode === "headless";
  return {
    attentionState: "needs_you",
    attentionReason: headless && exitCode === 0 ? "done" : "exit",
  };
}

/** The daemon learned the agent CLI's own session id (from its hooks). */
export async function handleSession(
  hostId: string,
  terminalId: string,
  agentSessionId: unknown,
): Promise<void> {
  if (typeof agentSessionId !== "string" || !/^[\w.-]{1,128}$/.test(agentSessionId)) return;
  const row = await getTerminal(terminalId);
  if (!row || row.hostId !== hostId || row.agentSessionId === agentSessionId) return;
  const updated = await updateTerminal(terminalId, { agentSessionId });
  if (updated) await notifyChanged(updated);
}

/**
 * Resume an exited (or still running) agent session as a fresh interactive
 * terminal in the same dir — `claude --resume <id>`. The new row inherits the
 * blueprint / ticket links so its badges carry over; it is `spawnedBy:
 * "resume"`, so exiting it later doesn't re-enter the needs-you queue.
 */
export async function resumeTerminal(row: LocalTerminalRow): Promise<LocalTerminalRow> {
  const spec = row.spec as unknown as LocalTerminalSpec;
  if (spec.kind !== "agent") throw new Error("Only agent sessions can be resumed");
  if (!row.agentSessionId) throw new Error("This session never reported a session id to resume");
  if (spec.agent !== "claude-code" && spec.agent !== "codex") {
    throw new Error(`Resume is not supported for ${spec.agent}`);
  }
  const host = await getHost(row.hostId);
  if (!host) throw new Error("Host not found");
  return createTerminal({
    host,
    userId: row.userId,
    workspaceId: row.workspaceId,
    dir: row.dir,
    spec: { kind: "agent", agent: spec.agent, resumeSessionId: row.agentSessionId },
    title: row.title.startsWith("↺ ") ? row.title : `↺ ${row.title}`,
    spawnedBy: "resume",
    blueprintId: row.blueprintId ?? undefined,
    triggerId: row.triggerId ?? undefined,
    ticket:
      row.ticketSource && row.ticketExternalId
        ? {
            source: row.ticketSource,
            externalId: row.ticketExternalId,
            url: row.ticketUrl ?? undefined,
          }
        : undefined,
  });
}

export async function handleAttention(
  hostId: string,
  terminalId: string,
  state: LocalAttentionState,
  reason: string,
): Promise<void> {
  const row = await getTerminal(terminalId);
  if (!row || row.hostId !== hostId || row.state !== "running") return;
  if (row.attentionState === state && row.attentionReason === reason) return;
  // CAS on state="running" so an exit landing first wins the row.
  await transitionTerminal(
    terminalId,
    ["running"],
    {
      attentionState: state,
      attentionReason: reason.slice(0, 100),
    },
    { hostId },
  );
}

export async function handlePreview(
  hostId: string,
  terminalId: string,
  preview: string,
  lastActivityAt: string,
): Promise<void> {
  const at = new Date(lastActivityAt);
  await db
    .update(localTerminals)
    .set({
      preview: preview.slice(0, 4000),
      lastActivityAt: isNaN(at.getTime()) ? new Date() : at,
      updatedAt: new Date(),
    })
    .where(and(eq(localTerminals.id, terminalId), eq(localTerminals.hostId, hostId)));
  // Previews are wall-view sugar — no nudge per preview (they're throttled
  // daemon-side but would still swamp the events channel across terminals).
}

/**
 * Largest final screen we keep per terminal. The daemon's ring is 512 KB
 * and it sends a bounded tail (see terminal-manager.ts), so this only guards
 * against a misbehaving daemon; a snapshot over the cap is dropped, and the
 * pane falls back to the text preview.
 */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_DIMENSION = 1000;

export interface LocalTerminalSnapshot {
  data: Buffer;
  cols: number;
  rows: number;
}

/**
 * The daemon's final screen for a terminal, sent right before `exit`. Only
 * the owning host may write it, and only while the terminal is still live —
 * a stale daemon can't overwrite the screen of a resumed/re-run row.
 */
export async function handleSnapshot(
  hostId: string,
  terminalId: string,
  dataB64: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  if (typeof dataB64 !== "string" || dataB64.length === 0) return false;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return false;
  const data = Buffer.from(dataB64, "base64");
  if (data.length === 0 || data.length > MAX_SNAPSHOT_BYTES) return false;
  const row = await getTerminal(terminalId);
  if (!row || row.hostId !== hostId) return false;
  if (row.state !== "running" && row.state !== "launching") return false;
  const grid = {
    cols: Math.min(cols, MAX_SNAPSHOT_DIMENSION),
    rows: Math.min(rows, MAX_SNAPSHOT_DIMENSION),
  };
  await db
    .insert(localTerminalSnapshots)
    .values({ terminalId, data, ...grid })
    .onConflictDoUpdate({
      target: localTerminalSnapshots.terminalId,
      set: { data, ...grid, createdAt: new Date() },
    });
  return true;
}

/** The recorded final screen of an exited terminal, if the daemon sent one. */
/** Just the grid a terminal's final screen was recorded at. */
async function getSnapshotGrid(terminalId: string): Promise<{ cols: number; rows: number } | null> {
  const [row] = await db
    .select({ cols: localTerminalSnapshots.cols, rows: localTerminalSnapshots.rows })
    .from(localTerminalSnapshots)
    .where(eq(localTerminalSnapshots.terminalId, terminalId));
  return row ?? null;
}

export async function getSnapshot(terminalId: string): Promise<LocalTerminalSnapshot | null> {
  const [row] = await db
    .select({
      data: localTerminalSnapshots.data,
      cols: localTerminalSnapshots.cols,
      rows: localTerminalSnapshots.rows,
    })
    .from(localTerminalSnapshots)
    .where(eq(localTerminalSnapshots.terminalId, terminalId));
  return row ?? null;
}

const TRANSCRIPT_ROLES = new Set<LocalTranscriptRole>(["user", "assistant", "tool"]);
const TRANSCRIPT_KINDS = new Set<LocalTranscriptKind>([
  "text",
  "thinking",
  "tool_use",
  "tool_result",
]);
/** Largest batch accepted in one `transcript` frame (the daemon sends 40). */
const MAX_TRANSCRIPT_BATCH = 500;

/** Validate a daemon-supplied transcript batch: known roles / kinds, bounded text, integer seqs. */
export function sanitizeTranscriptEntries(input: unknown): LocalTranscriptEntry[] {
  if (!Array.isArray(input)) return [];
  const out: LocalTranscriptEntry[] = [];
  const seen = new Set<number>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (
      !Number.isInteger(e.seq) ||
      (e.seq as number) < 1 ||
      (e.seq as number) > LOCAL_TRANSCRIPT_MAX_ENTRIES ||
      seen.has(e.seq as number) ||
      !TRANSCRIPT_ROLES.has(e.role as LocalTranscriptRole) ||
      !TRANSCRIPT_KINDS.has(e.kind as LocalTranscriptKind) ||
      typeof e.text !== "string"
    ) {
      continue;
    }
    seen.add(e.seq as number);
    const at = typeof e.at === "string" ? new Date(e.at) : null;
    out.push({
      seq: e.seq as number,
      role: e.role as LocalTranscriptRole,
      kind: e.kind as LocalTranscriptKind,
      text: e.text.slice(0, LOCAL_TRANSCRIPT_TEXT_MAX),
      detail: typeof e.detail === "string" ? e.detail.slice(0, LOCAL_TRANSCRIPT_DETAIL_MAX) : null,
      toolName: typeof e.toolName === "string" ? e.toolName.slice(0, 100) : null,
      toolUseId: typeof e.toolUseId === "string" ? e.toolUseId.slice(0, 200) : null,
      isError: e.isError === true,
      at: at && !isNaN(at.getTime()) ? at.toISOString() : null,
    });
    if (out.length >= MAX_TRANSCRIPT_BATCH) break;
  }
  return out;
}

/**
 * The daemon read new conversation entries from the agent's transcript.
 * Only the owning host may write, and only while the row is live (or in
 * the same breath as its exit — the final flush precedes `exit` on the
 * socket, so the row is still running when it lands). Keyed by seq, so a
 * batch the daemon re-sends after a reconnect is a no-op.
 */
export async function handleTranscript(
  hostId: string,
  terminalId: string,
  entries: unknown,
): Promise<number> {
  const clean = sanitizeTranscriptEntries(entries);
  if (clean.length === 0) return 0;
  const row = await getTerminal(terminalId);
  if (!row || row.hostId !== hostId) return 0;
  if (row.state !== "running" && row.state !== "launching") return 0;
  const inserted = await db
    .insert(localTerminalTranscripts)
    .values(
      clean.map((e) => ({
        terminalId,
        seq: e.seq,
        role: e.role,
        kind: e.kind,
        text: e.text,
        detail: e.detail,
        toolName: e.toolName,
        toolUseId: e.toolUseId,
        isError: e.isError,
        at: e.at ? new Date(e.at) : null,
      })),
    )
    .onConflictDoNothing()
    .returning({ seq: localTerminalTranscripts.seq });
  return inserted.length;
}

/** The stored conversation of a terminal, in order, optionally only entries after `afterSeq`. */
export async function getTranscript(
  terminalId: string,
  afterSeq = 0,
  limit = 2000,
): Promise<LocalTranscriptEntry[]> {
  const rows = await db
    .select()
    .from(localTerminalTranscripts)
    .where(
      and(
        eq(localTerminalTranscripts.terminalId, terminalId),
        gt(localTerminalTranscripts.seq, afterSeq),
      ),
    )
    .orderBy(asc(localTerminalTranscripts.seq))
    .limit(limit);
  return rows.map((r) => ({
    seq: r.seq,
    role: r.role as LocalTranscriptRole,
    kind: r.kind as LocalTranscriptKind,
    text: r.text,
    detail: r.detail,
    toolName: r.toolName,
    toolUseId: r.toolUseId,
    isError: r.isError,
    at: r.at ? r.at.toISOString() : null,
  }));
}

/** How many transcript entries a terminal has (0 = no conversation recorded). */
export async function countTranscript(terminalId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(localTerminalTranscripts)
    .where(eq(localTerminalTranscripts.terminalId, terminalId));
  return row?.n ?? 0;
}

const LINK_KINDS = new Set(["pr", "issue", "ref"]);
const LINK_PROVIDERS = new Set(["github", "gitlab", "linear", "jira"]);

/** Validate a daemon-supplied link list: https URLs only, known kinds/providers, capped. */
export function sanitizeWorkLinks(input: unknown): WorkLink[] {
  if (!Array.isArray(input)) return [];
  const out: WorkLink[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Record<string, unknown>;
    if (
      typeof l.url !== "string" ||
      !/^https:\/\/[^\s"'<>]{1,500}$/.test(l.url) ||
      typeof l.label !== "string" ||
      !LINK_KINDS.has(String(l.kind)) ||
      !LINK_PROVIDERS.has(String(l.provider)) ||
      seen.has(l.url)
    ) {
      continue;
    }
    seen.add(l.url);
    out.push({
      url: l.url,
      kind: l.kind as WorkLink["kind"],
      provider: l.provider as WorkLink["provider"],
      label: l.label.slice(0, 120),
    });
    if (out.length >= MAX_WORK_LINKS) break;
  }
  return out;
}

/** Daemon spotted a changed set of PR / ticket links in the output. */
export async function handleLinks(
  hostId: string,
  terminalId: string,
  links: unknown,
): Promise<void> {
  const clean = sanitizeWorkLinks(links);
  const [row] = await db
    .update(localTerminals)
    .set({ links: clean, updatedAt: new Date() })
    .where(and(eq(localTerminals.id, terminalId), eq(localTerminals.hostId, hostId)))
    .returning();
  // Links change the card, so (unlike previews) this nudges the cockpit.
  if (row) await notifyChanged(row);
}

const USAGE_MAX = 1e12;

/** Validate a daemon-supplied usage summary: finite non-negative numbers, bounded strings. */
export function sanitizeUsage(input: unknown): LocalTerminalUsage | null {
  if (!input || typeof input !== "object") return null;
  const u = input as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, USAGE_MAX) : 0;
  const turns = num(u.turns);
  if (turns === 0) return null;
  const updatedAt = new Date(typeof u.updatedAt === "string" ? u.updatedAt : NaN);
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    turns,
    model: typeof u.model === "string" ? u.model.slice(0, 100) : null,
    costUsd: typeof u.costUsd === "number" && Number.isFinite(u.costUsd) ? num(u.costUsd) : null,
    updatedAt: (isNaN(updatedAt.getTime()) ? new Date() : updatedAt).toISOString(),
  };
}

export async function handleUsage(
  hostId: string,
  terminalId: string,
  usage: unknown,
): Promise<void> {
  const clean = sanitizeUsage(usage);
  if (!clean) return;
  const [row] = await db
    .update(localTerminals)
    .set({ usage: clean, updatedAt: new Date() })
    .where(and(eq(localTerminals.id, terminalId), eq(localTerminals.hostId, hostId)))
    .returning();
  // Once per agent turn at most — cheap enough to nudge the header live.
  if (row) await notifyChanged(row);
}

/** User-facing rename; the daemon never sets titles after spawn. */
export async function renameTerminal(
  terminal: LocalTerminalRow,
  title: string,
): Promise<LocalTerminalRow> {
  const clean = title.trim().slice(0, 200);
  if (!clean || clean === terminal.title) return terminal;
  return (await updateTerminal(terminal.id, { title: clean })) ?? terminal;
}

/**
 * Reconcile DB rows against the daemon's hello: rows we believed live that
 * the daemon doesn't have died with the previous daemon process; parked
 * spawns are flushed.
 */
/**
 * Reconcile DB liveness against the daemon's hello. Rows the daemon no longer
 * has are failed; rows it reports running are promoted. Must run BEFORE the
 * daemon is registered in the relay: once it is registered, a concurrent
 * createTerminal can send a spawn that this pass would then mistake for a
 * terminal orphaned by the restart and kill it (the daemon's hello predates
 * the spawn, so the terminal isn't in its list).
 *
 * `flushParked` (default true) also re-spawns terminals parked while the host
 * was offline; the daemon socket must be registered for that to succeed. The
 * daemon handler passes false and calls `flushParkedTerminals` itself after
 * registration.
 */
export async function reconcileHello(
  hostId: string,
  daemonTerminals: LocalDaemonTerminalSync[],
  opts: { flushParked?: boolean } = {},
): Promise<void> {
  const alive = new Set(daemonTerminals.filter((t) => t.running).map((t) => t.terminalId));

  const believedLive = await db
    .select()
    .from(localTerminals)
    .where(
      and(
        eq(localTerminals.hostId, hostId),
        inArray(localTerminals.state, ["launching", "running"]),
      ),
    );
  for (const row of believedLive) {
    if (alive.has(row.id)) {
      // The daemon's hello is the authority on liveness. A row still in
      // `launching` (its `started` frame was lost mid-connect) that the
      // daemon reports running must be promoted — otherwise the sweeper
      // would later error a genuinely live PTY.
      if (row.state === "launching") {
        const spec = row.spec as unknown as LocalTerminalSpec;
        await transitionTerminal(
          row.id,
          ["launching"],
          {
            state: "running",
            startedAt: row.startedAt ?? new Date(),
            attentionState: spec.kind === "shell" ? "idle" : "working",
            attentionReason: null,
            errorMessage: null,
          },
          { hostId },
        );
      }
    } else {
      await transitionTerminal(
        row.id,
        ["launching", "running"],
        {
          state: "exited",
          errorMessage: "Daemon restarted while the terminal was running",
          endedAt: new Date(),
          ...exitAttention(row, null),
        },
        { hostId },
      );
    }
  }

  if (opts.flushParked ?? true) await flushParkedTerminals(hostId);
}

/** Re-spawn terminals parked in pending/host_offline now that the host is online. */
export async function flushParkedTerminals(hostId: string): Promise<void> {
  const parked = await db
    .select()
    .from(localTerminals)
    .where(
      and(
        eq(localTerminals.hostId, hostId),
        eq(localTerminals.state, "pending"),
        eq(localTerminals.pendingReason, "host_offline"),
      ),
    );
  for (const row of parked) {
    await trySpawn(row);
  }
}

export async function handleHostDisconnect(hostId: string): Promise<void> {
  // Terminal rows stay as-is: a network blip doesn't kill PTYs, and the next
  // hello reconciles reality. Browsers were closed by the relay (4503).
  const host = await getHost(hostId);
  if (host) {
    const { markHostOffline } = await import("./local-host-service.js");
    await markHostOffline(hostId);
  }
}

/** Sweeper: fail `launching` rows whose daemon never acked the spawn. */
export async function sweepStuckLaunching(): Promise<void> {
  const cutoff = new Date(Date.now() - LOCAL_LAUNCH_TIMEOUT_MS);
  const stuck = await db
    .select()
    .from(localTerminals)
    .where(and(eq(localTerminals.state, "launching"), lt(localTerminals.updatedAt, cutoff)));
  for (const row of stuck) {
    logger.warn({ terminalId: row.id, hostId: row.hostId }, "local: spawn timed out");
    // CAS: a `started` frame racing the sweep wins the row instead of being
    // clobbered back to error.
    await transitionTerminal(row.id, ["launching"], {
      state: "error",
      errorMessage: "Spawn timed out — host did not acknowledge",
      endedAt: new Date(),
    });
  }
}

function lastPathSegment(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
