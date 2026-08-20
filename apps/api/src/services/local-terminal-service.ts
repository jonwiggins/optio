/**
 * Optio Local terminals: DB state machine + spawn orchestration over the
 * daemon relay. See docs/optio-local.md.
 *
 * State machine: pending → launching → running → exited | error.
 * The daemon is authoritative for the process; this service is authoritative
 * for the DB row and publishes content-free nudges + browser status frames on
 * every transition.
 */
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  LOCAL_DEFAULT_COLS,
  LOCAL_DEFAULT_ROWS,
  LOCAL_LAUNCH_TIMEOUT_MS,
  type LocalAttentionState,
  type LocalDaemonTerminalSync,
  type LocalSpawnSource,
  type LocalTerminalSpec,
} from "@optio/shared";
import { db } from "../db/client.js";
import { localTerminals } from "../db/schema.js";
import { logger } from "../logger.js";
import { publishLocalChanged } from "./event-bus.js";
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
  return !terminal.userId || terminal.userId === (userId ?? null);
}

/** Human-readable rendering of a spec for list views. Never re-executed. */
export function describeSpec(spec: LocalTerminalSpec): string | null {
  switch (spec.kind) {
    case "shell":
      return null;
    case "command":
      return spec.command;
    case "agent": {
      const bin = AGENT_BINS[spec.agent] ?? spec.agent;
      if (!spec.prompt) return bin;
      const short = spec.prompt.length > 120 ? `${spec.prompt.slice(0, 117)}...` : spec.prompt;
      return `${bin} "${short.replaceAll("\n", " ")}"`;
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
  const spec = input.spec;
  if (spec.kind === "agent" && !AGENT_BINS[spec.agent]) {
    throw new Error(`Unknown agent kind: ${spec.agent}`);
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

/** Send the spawn to the daemon; parks in pending/host_offline when unreachable. */
async function trySpawn(row: LocalTerminalRow): Promise<LocalTerminalRow | null> {
  const sent = relay.sendToHost(row.hostId, {
    type: "spawn",
    terminalId: row.id,
    dir: row.dir,
    cols: LOCAL_DEFAULT_COLS,
    rows: LOCAL_DEFAULT_ROWS,
    spec: row.spec as unknown as LocalTerminalSpec,
  });
  if (sent) {
    return updateTerminal(row.id, { state: "launching", pendingReason: null });
  }
  return updateTerminal(row.id, { state: "pending", pendingReason: "host_offline" });
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
  if (!sent) throw new Error("Host is offline");
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

export async function handleStarted(terminalId: string): Promise<void> {
  const row = await getTerminal(terminalId);
  if (!row || row.state !== "launching") return;
  const spec = row.spec as unknown as LocalTerminalSpec;
  await updateTerminal(terminalId, {
    state: "running",
    startedAt: new Date(),
    attentionState: spec.kind === "shell" ? "idle" : "working",
    attentionReason: null,
    errorMessage: null,
  });
}

export async function handleSpawnError(terminalId: string, message: string): Promise<void> {
  await updateTerminal(terminalId, {
    state: "error",
    errorMessage: message.slice(0, 2000),
    endedAt: new Date(),
  });
}

export async function handleExit(terminalId: string, exitCode: number | null): Promise<void> {
  const row = await getTerminal(terminalId);
  if (!row || (row.state !== "running" && row.state !== "launching")) return;
  const updated = await updateTerminal(terminalId, {
    state: "exited",
    exitCode,
    endedAt: new Date(),
    // Automation results land in the "needs you" queue for review; a shell
    // you typed `exit` into does not demand attention.
    attentionState: row.spawnedBy === "manual" ? "idle" : "needs_you",
    attentionReason: row.spawnedBy === "manual" ? null : "exit",
  });
  if (updated) relay.notifyBrowsers(terminalId, { type: "exit", exitCode });
}

export async function handleAttention(
  terminalId: string,
  state: LocalAttentionState,
  reason: string,
): Promise<void> {
  const row = await getTerminal(terminalId);
  if (!row || row.state !== "running") return;
  if (row.attentionState === state && row.attentionReason === reason) return;
  await updateTerminal(terminalId, {
    attentionState: state,
    attentionReason: reason.slice(0, 100),
  });
}

export async function handlePreview(
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
    .where(eq(localTerminals.id, terminalId));
  // Previews are wall-view sugar — no nudge per preview (they're throttled
  // daemon-side but would still swamp the events channel across terminals).
}

/**
 * Reconcile DB rows against the daemon's hello: rows we believed live that
 * the daemon doesn't have died with the previous daemon process; parked
 * spawns are flushed.
 */
export async function reconcileHello(
  hostId: string,
  daemonTerminals: LocalDaemonTerminalSync[],
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
    if (!alive.has(row.id)) {
      await updateTerminal(row.id, {
        state: "exited",
        errorMessage: "Daemon restarted while the terminal was running",
        endedAt: new Date(),
        attentionState: row.spawnedBy === "manual" ? "idle" : "needs_you",
        attentionReason: row.spawnedBy === "manual" ? null : "exit",
      });
    }
  }

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
    await updateTerminal(row.id, {
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
