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
  MAX_WORK_LINKS,
  type WorkLink,
  type LocalAttentionState,
  type LocalDaemonTerminalSync,
  type LocalSpawnSource,
  type LocalTerminalSpec,
} from "@optio/shared";
import { db } from "../db/client.js";
import { localTerminals } from "../db/schema.js";
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
      // Automation results land in the "needs you" queue for review; a shell
      // you typed `exit` into does not demand attention.
      attentionState: row.spawnedBy === "manual" ? "idle" : "needs_you",
      attentionReason: row.spawnedBy === "manual" ? null : "exit",
    },
    { hostId },
  );
  if (updated) relay.notifyBrowsers(terminalId, { type: "exit", exitCode });
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
          attentionState: row.spawnedBy === "manual" ? "idle" : "needs_you",
          attentionReason: row.spawnedBy === "manual" ? null : "exit",
        },
        { hostId },
      );
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
