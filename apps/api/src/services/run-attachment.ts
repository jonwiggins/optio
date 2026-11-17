/**
 * Run attachment (docs/plans/scale-out.md §1–2): how an API instance holds,
 * streams, settles and hands over an agent run that lives in its pod under
 * the run protocol (run-protocol.ts in @optio/container-runtime).
 *
 * A run row — a task or Job run, a PR-review run, a persistent-agent turn —
 * carries `exec_state` / `exec_pid` (the supervisor in the pod),
 * `consumed_bytes` (how much of the pod's output file is log rows) and
 * `attached_by` / `attach_lease_until` (which hold streams it, until when).
 * This module owns those columns:
 *
 *   hold      the job that claimed the run holds its attachment from the
 *             claim on, renewing every ATTACH_RENEW_MS while it sets the run
 *             up, streams it and settles it; `attached_by` names the hold
 *             itself (`<instance>/<nonce>`), so two jobs of one instance —
 *             an old attempt's and a new one's — are never mistaken for each
 *             other; a renewal that finds the run taken severs the stream
 *   start     the supervisor launched: exec_state = started, offset 0
 *   claim     a re-attach: one CAS that wins only when the lease expired and
 *             the run is still active
 *   stream    the output file from byte 0, every complete line to the
 *             derivations (lines below the offset were persisted by an
 *             earlier attachment and are replayed only), the rest stored as
 *             log rows in batches committed with the new offset in one
 *             transaction, so a run that changes hands never gets a
 *             duplicate or a gap
 *   settle    the agent exited and its output is consumed: exec_state =
 *             exited, with the run's spend in the same statement, once
 *   end       the job lets go (`endRunJob`): an agent it started or claimed
 *             that may still run, with nobody else to finish it, is stopped
 *             before anything is given back — unless the job failed while
 *             streaming or settling (`onStreamError`): that is this
 *             instance's trouble, not the run's, so the lease goes and the
 *             reconciler re-attaches, up to MAX_ATTACH_FAILURES failed
 *             attach jobs in a row before the run is failed
 *   detach    on shutdown: every stream severed and its lease given up now,
 *             so another instance picks the runs up in seconds; runs past
 *             their stream finish settling here first
 *
 * What a run's exit means is the workers' business, as before.
 */
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  RunStdinClosedError,
  STDIN_EOF_SENTINEL,
  type ContainerRuntime,
  type RunExit,
} from "@optio/container-runtime";
import type { AgentLogEntry, ContainerHandle } from "@optio/shared";
import {
  ATTACH_LEASE_MS as DEFAULT_ATTACH_LEASE_MS,
  ATTACH_RENEW_MS as DEFAULT_ATTACH_RENEW_MS,
  parseIntEnv,
  PR_REVIEW_OUTPUT_PATH,
  shellQuote,
} from "@optio/shared";
import { db } from "../db/client.js";
import { persistentAgentTurns, prReviewRuns, workRuns } from "../db/schema.js";
import { INSTANCE_ID } from "./instance.js";
import {
  AttachmentLostError,
  appendRunLogsBatch,
  runRowTable,
  type LogLine,
  type LogRow,
  type RunRowKind,
  type RunRowRef,
} from "./run-log-service.js";
import * as podPool from "./agent-pod-pool.js";
import { getRuntime } from "./container-service.js";
import { RUN_HOMES_DIR, runHome } from "../utils/harness-config.js";
import { logger } from "../logger.js";

export { AttachmentLostError };

/**
 * How long an attachment lasts without a renewal, and how often the holder
 * renews (docs/plans/scale-out.md §2: 60 s / 20 s). Shorter in the
 * scale-out e2e tier, so a killed server's runs move on in seconds.
 */
export const ATTACH_LEASE_MS = parseIntEnv("OPTIO_ATTACH_LEASE_MS", DEFAULT_ATTACH_LEASE_MS);
export const ATTACH_RENEW_MS = parseIntEnv(
  "OPTIO_ATTACH_RENEW_MS",
  Math.min(DEFAULT_ATTACH_RENEW_MS, Math.floor(ATTACH_LEASE_MS / 3)),
);
/**
 * On shutdown, how long runs past their stream get to finish settling here
 * before the process goes on closing (well under the pod's 60 s grace).
 */
export const DETACH_SETTLE_WAIT_MS = parseIntEnv("OPTIO_DETACH_SETTLE_WAIT_MS", 20_000);
/** Test knob (the scale-out e2e tier): a pause right after a run's exit is recorded. */
const SETTLE_PAUSE_MS = parseIntEnv("OPTIO_SETTLE_PAUSE_MS", 0);
/**
 * Test knobs (the scale-out e2e tier): a new output line equal to this
 * makes the log write fail, in every job (`OPTIO_TEST_STREAM_FAULT`) or only
 * in the job that started the run (`OPTIO_TEST_STREAM_FAULT_FIRST`).
 */
const STREAM_FAULT = process.env.OPTIO_TEST_STREAM_FAULT || null;
const STREAM_FAULT_FIRST = process.env.OPTIO_TEST_STREAM_FAULT_FIRST || null;
/** How many attach jobs in a row may fail one attempt before the run is failed. */
export const MAX_ATTACH_FAILURES = 3;

/** A run row with the attachment columns (see RunRowKind). */
export type AttachRef = RunRowRef;

function leaseUntil(): Date {
  return new Date(Date.now() + ATTACH_LEASE_MS);
}

/** A hold's mark in `attached_by`: this instance, and a nonce of the hold's own. */
export function newHoldToken(): string {
  return `${INSTANCE_ID}/${randomBytes(4).toString("hex")}`;
}

/** The agent a job started or claimed: where it runs, and its supervisor. */
export interface RunAgent {
  /** The `agent_pods` row it runs in. */
  podId: string;
  pid: number;
}

/** What the column writes of a hold need: the run, and the hold's mark. */
export interface HoldRef {
  readonly ref: AttachRef;
  readonly token: string;
  /** The agent this hold is about, once started or claimed. */
  readonly agent?: RunAgent | null;
}

/**
 * Where a run row keeps its attachment's bookkeeping beyond the columns —
 * the count of attach jobs that failed the current attempt in a row, under
 * `attachFailures` — in a jsonb column it already has (no migration): a
 * task's or Job run's `metadata`, a review run's `metadata`, a turn's
 * `wake_payload`.
 */
function bookkeeping(kind: RunRowKind) {
  switch (kind) {
    case "work-run":
      return { key: "metadata", column: workRuns.metadata } as const;
    case "review-run":
      return { key: "metadata", column: prReviewRuns.metadata } as const;
    case "turn":
      return { key: "wakePayload", column: persistentAgentTurns.wakePayload } as const;
  }
}

/** The run is still active: its state says an agent may be running for it. */
function stillActive(kind: RunRowKind) {
  switch (kind) {
    case "work-run":
      return inArray(workRuns.state, ["provisioning", "running"]);
    case "review-run":
      return inArray(prReviewRuns.state, ["provisioning", "running"]);
    case "turn":
      return isNull(persistentAgentTurns.finishedAt);
  }
}

// ── The columns ─────────────────────────────────────────────────────────────

/** The claiming job takes the attachment: the run is this hold's from here. */
export async function holdAttachment(ref: AttachRef, token: string): Promise<void> {
  const t = runRowTable(ref.kind);
  await db
    .update(t)
    .set({ attachedBy: token, attachLeaseUntil: leaseUntil() })
    .where(eq(t.id, ref.id));
}

/**
 * The supervisor launched (`agent`, which the hold remembers whatever this
 * returns). A fresh start writes a fresh output file, so the consumed
 * offset starts over with it. False when the run is no longer this hold's
 * (it was queued again meanwhile, which clears the attachment): then the
 * agent just started is nobody's, and `endRunJob` stops it.
 */
export async function recordRunStarted(hold: AttachmentHold, agent: RunAgent): Promise<boolean> {
  hold.agent = agent;
  const t = runRowTable(hold.ref.kind);
  const book = bookkeeping(hold.ref.kind);
  const rows = await db
    .update(t)
    .set({
      execState: "started",
      execPid: agent.pid,
      consumedBytes: 0,
      attachLeaseUntil: leaseUntil(),
      // A new attempt: no attach job has failed it yet.
      [book.key]: sql`COALESCE(${book.column}, '{}'::jsonb) - 'attachFailures'`,
    } as Record<string, unknown>)
    .where(and(eq(t.id, hold.ref.id), eq(t.attachedBy, hold.token)))
    .returning({ id: t.id });
  return rows.length > 0;
}

export interface AttachmentClaim {
  /** Where the run's log rows reach: the stream persists from here on. */
  consumedBytes: number;
  /** `exited`: an earlier holder recorded the run's exit and went away before settling the rest. */
  execState: "started" | "exited";
  /** The agent's supervisor, as its start recorded it. */
  pid: number | null;
}

/**
 * A re-attach: the hold `token` takes the run iff its agent was started (or
 * its exit is half recorded), the run is still active — a run already
 * terminal is never claimed — and nobody holds it: the lease expired, or
 * the attachment was closed, whoever held it (this instance too: a job of
 * this instance that still holds the run renews its lease). Null when the
 * claim lost.
 */
export async function claimAttachment(
  ref: AttachRef,
  token: string = newHoldToken(),
): Promise<(AttachmentClaim & { token: string }) | null> {
  const t = runRowTable(ref.kind);
  const [row] = await db
    .update(t)
    .set({ attachedBy: token, attachLeaseUntil: leaseUntil() })
    .where(
      and(
        eq(t.id, ref.id),
        inArray(t.execState, ["started", "exited"]),
        stillActive(ref.kind),
        or(isNull(t.attachLeaseUntil), lt(t.attachLeaseUntil, sql`now()`)),
      ),
    )
    .returning({ consumedBytes: t.consumedBytes, execState: t.execState, pid: t.execPid });
  if (!row || (row.execState !== "started" && row.execState !== "exited")) return null;
  return {
    consumedBytes: Number(row.consumedBytes),
    execState: row.execState,
    pid: row.pid ?? null,
    token,
  };
}

/** Extends the hold's attachment. False when the run was taken from it (or queued again). */
export async function renewAttachment(hold: HoldRef): Promise<boolean> {
  const t = runRowTable(hold.ref.kind);
  const rows = await db
    .update(t)
    .set({ attachLeaseUntil: leaseUntil() })
    .where(and(eq(t.id, hold.ref.id), eq(t.attachedBy, hold.token)))
    .returning({ id: t.id });
  return rows.length > 0;
}

/** Gives the attachment up now (shutdown, or the hold stops streaming the run). */
export async function releaseAttachment(hold: HoldRef): Promise<void> {
  const t = runRowTable(hold.ref.kind);
  await db
    .update(t)
    // Claims compare against Postgres now(); an API clock ahead of the
    // database must not leave this released lease in the future.
    .set({ attachLeaseUntil: sql`now()` })
    .where(and(eq(t.id, hold.ref.id), eq(t.attachedBy, hold.token)));
}

/** The run is over and settled: nothing is attached to it any more. */
export async function closeAttachment(hold: HoldRef): Promise<void> {
  const t = runRowTable(hold.ref.kind);
  await db
    .update(t)
    .set({ attachedBy: null, attachLeaseUntil: null })
    .where(and(eq(t.id, hold.ref.id), eq(t.attachedBy, hold.token)));
}

/**
 * How a hold lost its run: `taken` — another hold has the same attempt
 * (its agent, its pid) — or `reset` — the attempt is over without its
 * agent's exit: the run was queued again (exec state cleared), or a new
 * attempt started.
 */
export type HoldLoss = "taken" | "reset";

/** Reads why `hold` no longer has its run (see HoldLoss). */
export async function classifyLoss(hold: HoldRef): Promise<HoldLoss> {
  const t = runRowTable(hold.ref.kind);
  const [row] = await db
    .select({ execState: t.execState, execPid: t.execPid })
    .from(t)
    .where(eq(t.id, hold.ref.id));
  if (!row || row.execState == null) return "reset";
  if (hold.agent && row.execPid !== hold.agent.pid) return "reset";
  return "taken";
}

/**
 * One more attach job failed the hold's attempt: the count goes up by one
 * (a CAS on the hold) and is returned. Null when the hold no longer has the
 * run.
 */
export async function countAttachFailure(hold: HoldRef): Promise<number | null> {
  const t = runRowTable(hold.ref.kind);
  const book = bookkeeping(hold.ref.kind);
  const [row] = await db
    .update(t)
    .set({
      [book.key]: sql`jsonb_set(COALESCE(${book.column}, '{}'::jsonb), '{attachFailures}', to_jsonb(COALESCE((${book.column}->>'attachFailures')::int, 0) + 1))`,
    })
    .where(and(eq(t.id, hold.ref.id), eq(t.attachedBy, hold.token)))
    .returning({ failures: sql<number>`(${book.column}->>'attachFailures')::int` });
  return row ? Number(row.failures) : null;
}

/** An attach job made progress on the attempt: the failures before it were not in a row. */
export async function clearAttachFailures(hold: HoldRef): Promise<void> {
  const t = runRowTable(hold.ref.kind);
  const book = bookkeeping(hold.ref.kind);
  await db
    .update(t)
    .set({
      [book.key]: sql`COALESCE(${book.column}, '{}'::jsonb) - 'attachFailures'`,
    })
    .where(
      and(
        eq(t.id, hold.ref.id),
        eq(t.attachedBy, hold.token),
        sql`${book.column} ? 'attachFailures'`,
      ),
    );
}

/**
 * How settling a run went: `settled` (this call recorded the exit, and the
 * spend with it), `already` (an earlier holder recorded both and went away
 * before finishing: do the rest, but add nothing), `taken` (another hold
 * has the run now: leave it), or `reset` (the attempt was queued again or
 * replaced: it is over for this job).
 */
export type SettleResult = "settled" | "already" | HoldLoss;

/**
 * The agent exited (or its run is lost) and its output is consumed: record
 * `exec_state = exited` with `patch` (the run's spend, its result) in the
 * same statement, iff this hold has the run and nobody recorded the exit
 * before — so spend is added once, whoever finishes the run. `alsoInTx`
 * runs in the same transaction when this call is the one that settles
 * (spend that lives on another row: an agent's running total).
 */
export async function settleRun(
  hold: HoldRef,
  patch: Record<string, unknown> = {},
  alsoInTx?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>,
): Promise<SettleResult> {
  const t = runRowTable(hold.ref.kind);
  const outcome = await db.transaction(async (tx) => {
    const settled = await tx
      .update(t)
      .set({ ...patch, execState: "exited" })
      .where(and(eq(t.id, hold.ref.id), eq(t.attachedBy, hold.token), eq(t.execState, "started")))
      .returning({ id: t.id });
    if (settled.length > 0) {
      if (alsoInTx) await alsoInTx(tx);
      return "settled" as const;
    }
    const [row] = await tx
      .select({ execState: t.execState, attachedBy: t.attachedBy })
      .from(t)
      .where(eq(t.id, hold.ref.id));
    return row && row.attachedBy === hold.token && row.execState === "exited"
      ? ("already" as const)
      : null;
  });
  if (outcome === "settled" && SETTLE_PAUSE_MS > 0) {
    await new Promise((r) => setTimeout(r, SETTLE_PAUSE_MS));
  }
  return outcome ?? classifyLoss(hold);
}

// ── The hold: a renewing attachment with shutdown bookkeeping ───────────────

/**
 * Where a hold is: setting the run up (`setup`), streaming its output
 * (`streaming`), or past the stream, settling its result (`settling`).
 * Shutdown lets the first two go at once and waits for the third.
 */
export type HoldPhase = "setup" | "streaming" | "settling";

/** A hold a job has on a run: renewed every ATTACH_RENEW_MS until it ends. */
export interface AttachmentHold extends HoldRef {
  /** The job that holds it: the one that started the run, or an attach job. */
  readonly origin: "start" | "attach";
  /** The agent the job started or claimed: what `endRunJob` stops if it is left behind. */
  agent: RunAgent | null;
  phase: HoldPhase;
  /** True once a renewal found the run taken (or queued again). */
  readonly lost: boolean;
  /** True once shutdown let the run go (its lease given up for another instance). */
  readonly released: boolean;
  /** What to sever when the hold must end at once (the live stream). */
  attachment: { close(): void } | null;
  /** Settles once the hold ended. */
  readonly done: Promise<void>;
  /** Stops renewing; with `release`, gives the lease up now. Idempotent. */
  end(opts?: { release?: boolean }): Promise<void>;
}

const holds = new Set<Hold>();
let shuttingDown = false;

class Hold implements AttachmentHold {
  agent: RunAgent | null;
  phase: HoldPhase;
  attachment: { close(): void } | null = null;
  readonly done: Promise<void>;
  private isLost = false;
  private isReleased = false;
  private ended = false;
  private timer: NodeJS.Timeout | null;
  private resolveDone: () => void = () => {};

  readonly origin: "start" | "attach";

  constructor(
    readonly ref: AttachRef,
    readonly token: string,
    opts: { phase: HoldPhase; agent: RunAgent | null; origin: "start" | "attach" },
  ) {
    this.origin = opts.origin;
    this.phase = opts.phase;
    this.agent = opts.agent;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.timer = setInterval(() => this.renew(), ATTACH_RENEW_MS);
    this.timer.unref?.();
    holds.add(this);
  }

  get lost(): boolean {
    return this.isLost;
  }

  get released(): boolean {
    return this.isReleased;
  }

  private renew(): void {
    renewAttachment(this)
      .then((ok) => {
        if (ok || this.isLost || this.ended) return;
        this.isLost = true;
        logger.warn({ runId: this.ref.id }, "Run attachment taken or reset; detaching");
        this.sever();
      })
      .catch((err) => logger.warn({ err, runId: this.ref.id }, "Failed to renew run attachment"));
  }

  sever(): void {
    try {
      this.attachment?.close();
    } catch {
      // already closed
    }
  }

  /** Shutdown: the run goes to another instance — severed, the lease given up now. */
  async letGo(): Promise<void> {
    this.isReleased = true;
    this.sever();
    await this.end({ release: true });
  }

  async end(opts?: { release?: boolean }): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    holds.delete(this);
    try {
      if (opts?.release && !this.isLost) {
        await releaseAttachment(this).catch((err) =>
          logger.warn({ err, runId: this.ref.id }, "Failed to release run attachment"),
        );
      }
    } finally {
      this.resolveDone();
    }
  }
}

/**
 * Starts holding a run this job just claimed by its state machine (a run
 * it is about to set up): the lease is taken unconditionally under a new
 * hold token and renewed from here on.
 */
export async function beginHold(ref: AttachRef): Promise<AttachmentHold> {
  const token = newHoldToken();
  await holdAttachment(ref, token);
  return startHold(ref, token, { origin: "start" });
}

/**
 * Holds a run whose lease `token` has (a `claimAttachment` win, or
 * `holdAttachment`): renewed every ATTACH_RENEW_MS with `WHERE attached_by
 * = token`. A renewal that matches nothing means the run was taken or
 * queued again: the live stream is severed at once, and the stream loop
 * returns.
 */
export function startHold(
  ref: AttachRef,
  token: string,
  opts: { phase?: HoldPhase; agent?: RunAgent | null; origin?: "start" | "attach" } = {},
): AttachmentHold {
  return new Hold(ref, token, {
    phase: opts.phase ?? "setup",
    agent: opts.agent ?? null,
    origin: opts.origin ?? "attach",
  });
}

/** Whether a job of this process holds the run now (its hold not lost). */
export function holdsRun(ref: AttachRef): boolean {
  for (const hold of holds) {
    if (hold.ref.kind === ref.kind && hold.ref.id === ref.id && !hold.lost) return true;
  }
  return false;
}

/**
 * Shutdown: sever every live stream and give its lease up now, so other
 * instances pick the runs up in seconds rather than after a lease expiry.
 * The agents go on in their pods; the workers' jobs end with a detached
 * outcome and leave their runs as they are. Runs this instance is still
 * setting up are let go the same way (their next pass requeues or
 * re-attaches them). A run past its stream keeps its lease and finishes
 * settling here — its result recorded, its transitions and callbacks made
 * once — waited for up to DETACH_SETTLE_WAIT_MS; one that takes longer
 * keeps renewing until its job ends or the process does.
 */
export async function detachAll(
  opts: { settleWaitMs?: number } = {},
): Promise<{ detached: number; settled: number }> {
  shuttingDown = true;
  const all = [...holds];
  const settling = all.filter((h) => h.phase === "settling");
  const streaming = all.filter((h) => h.phase !== "settling");
  await Promise.all(streaming.map((hold) => hold.letGo()));
  if (settling.length > 0) {
    const waitMs = opts.settleWaitMs ?? DETACH_SETTLE_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(settling.map((h) => h.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    const left = settling.filter((h) => holds.has(h)).length;
    if (left > 0) {
      logger.warn({ left, waitMs }, "Runs still settling at shutdown; their leases stay theirs");
    }
  }
  return { detached: streaming.length, settled: settling.length };
}

/** True once `detachAll` ran: a worker must not start or settle anything more. */
export function isDetaching(): boolean {
  return shuttingDown;
}

/** How many runs this instance holds (diagnostics and tests). */
export function heldRunCount(): number {
  return holds.size;
}

// ── Letting go: the one rule for every job that started or claimed a run ────

/** How a worker's part in a run ended. */
export type RunEnd =
  /** It finished the run here: settled, transitioned, cleaned up. */
  | "finished"
  /** It left the run for whoever attaches next (shutdown, a dropped stream), or another hold has it. */
  | "detached"
  /** The attempt was queued again or replaced under it: it is over for this job. */
  | "reset"
  /** This job failed the run itself (attach jobs failed it too often): its agent is stopped. */
  | "failed";

/** The attachment columns `endRunJob` reads. */
interface AttachmentRow {
  execState: string | null;
  execPid: number | null;
  attachedBy: string | null;
  attachLeaseUntil: Date | null;
}

/**
 * Whether the agent a hold started or claimed is left behind — still
 * possibly running with nobody to finish it — given the run row now: true
 * unless its exit is recorded, or another hold streams that same agent
 * under a live lease. A run queued again or replaced leaves it behind.
 */
export function agentLeftBehind(
  hold: Pick<HoldRef, "token" | "agent">,
  row: AttachmentRow | undefined,
  now: Date = new Date(),
): boolean {
  if (!hold.agent) return false;
  if (!row) return true;
  if (row.execPid !== hold.agent.pid) return true;
  if (row.execState === "exited") return false;
  if (row.execState !== "started") return true;
  const elsewhere =
    row.attachedBy !== null &&
    row.attachedBy !== hold.token &&
    row.attachLeaseUntil !== null &&
    row.attachLeaseUntil.getTime() > now.getTime();
  return !elsewhere;
}

/**
 * How a job that started or claimed a run lets go of it — the one rule for
 * every run kind and every way the job ends (finished, detached, reset,
 * failed, a return halfway, a throw). Called before the job gives anything
 * else back (its pod slot): unless the job finished the run, or left it for
 * another instance or job (`detached`: shutdown, another hold, or an error
 * while streaming or settling — see `onStreamError`), the agent it started
 * or claimed is stopped when it is left behind (`agentLeftBehind`) — TERM,
 * scoped to its supervisor's pid. A job that ended without saying how
 * (`null`) is judged by where it was: still setting the run up, the rule
 * applies; past that, it detaches. Then the hold ends, its lease given up
 * unless the run finished here.
 */
export async function endRunJob(
  hold: AttachmentHold | null,
  end: RunEnd | null,
  log: typeof logger = logger,
): Promise<void> {
  if (!hold) return;
  const how = end ?? (hold.phase === "setup" ? null : "detached");
  try {
    const agent = hold.agent;
    if (agent && how !== "finished" && how !== "detached" && !hold.released) {
      const t = runRowTable(hold.ref.kind);
      const [row] = await db
        .select({
          execState: t.execState,
          execPid: t.execPid,
          attachedBy: t.attachedBy,
          attachLeaseUntil: t.attachLeaseUntil,
        })
        .from(t)
        .where(eq(t.id, hold.ref.id));
      if (agentLeftBehind(hold, row)) {
        const stopped = await signalRun(agent.podId, hold.ref.id, "TERM", { pid: agent.pid });
        log.info(
          { supervisorPid: agent.pid, stopped, end: how ?? "error" },
          "The run's agent was left behind by its job; stopped it",
        );
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to check the run's agent as its job ended");
  } finally {
    await hold.end({ release: how !== "finished" });
    // Shutdown let the run go while the job was still starting it: what the
    // job wrote since (its start, which takes a fresh lease) is given up too,
    // so another instance attaches in seconds.
    if (hold.released && !hold.lost) {
      await releaseAttachment(hold).catch((err) =>
        log.warn({ err }, "Failed to release run attachment"),
      );
    }
  }
}

/**
 * A job's error once its run's agent is streaming (or settling): this
 * instance's trouble — a database error writing the logs, a publish, a
 * parser — not the run's. The run is left for the reconciler to attach
 * again: how the job ends, for `endRunJob` and the pod slot —
 *
 *   detached  the lease is given up and the agent left running;
 *   reset     the hold lost its attempt meanwhile (queued again, replaced);
 *   failed    this attach job is the MAX_ATTACH_FAILURES-th in a row to fail
 *             the attempt (one that made progress resets the count; the job
 *             that started the run does not count): the caller fails the
 *             run with the error, and `endRunJob` stops its agent.
 *
 * Null while the job was still setting the run up: then the error is the
 * run's, and the job's own failure path applies as before.
 */
export async function onStreamError(
  hold: AttachmentHold | null,
  log: typeof logger = logger,
): Promise<Exclude<RunEnd, "finished"> | null> {
  if (!hold || hold.phase === "setup") return null;
  if (isDetaching() || hold.released) return "detached";
  try {
    if (hold.origin === "attach") {
      const failures = await countAttachFailure(hold);
      if (failures === null) return endOfLoss(await classifyLoss(hold));
      if (failures >= MAX_ATTACH_FAILURES) {
        log.warn({ failures }, "Attach jobs keep failing this run; failing it");
        return "failed";
      }
      log.warn({ failures }, "Attach job failed; the run is left for the next attach");
      return "detached";
    }
    if (!(await renewAttachment(hold))) return endOfLoss(await classifyLoss(hold));
    log.warn("The job streaming the run failed; the run is left for an attach");
    return "detached";
  } catch (err) {
    // The database is what failed, likely: leave the run all the same.
    log.warn({ err }, "Could not record the attach failure; leaving the run for an attach");
    return "detached";
  }
}

/** The error a run is failed with once attach jobs failed it too often. */
export function attachFailedMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Attaching to the run failed ${MAX_ATTACH_FAILURES} times in a row; last error: ${detail}`;
}

// ── Streaming: the one attach loop ──────────────────────────────────────────

/** How a streamed attachment ended. */
export type StreamOutcome =
  | RunExit
  /** This hold lost the run mid-stream to another hold. */
  | { kind: "taken" }
  /** The attempt was queued again or replaced under this hold. */
  | { kind: "reset" };

/** What a line parser makes of one line of agent output. */
export interface ParsedRunLine {
  entries: AgentLogEntry[];
  sessionId?: string;
  isTerminal?: boolean;
}

export interface StreamRunInput {
  runtime: ContainerRuntime;
  handle: ContainerHandle;
  ref: AttachRef;
  /** The run's directory in its pod (its run home). */
  runDir: string;
  hold: AttachmentHold;
  /** Where the run's log rows reach: lines ending at or before it are replayed, not stored. */
  consumedBytes: number;
  /** The kind's line parser (an agent's event parser, a command's line parser). */
  parse(line: string): ParsedRunLine;
  /**
   * Every complete line, replayed or new, in order: the in-memory
   * derivations rebuilt from byte 0 on every attach (the PR tool-call
   * tracker, the result digest, a command's exit receipt). Never persists.
   */
  derive?(line: string): void;
  /** The agent's session id, the first time a new (not replayed) line carries one: persist it. */
  onSession?(sessionId: string): Promise<void>;
  /** A new line's entries, before they are stored (signs of life). */
  onEntries?(entries: AgentLogEntry[]): void;
  /** A stored row's live frame. */
  publish(row: LogRow): Promise<void>;
  /** After each chunk of output (a heartbeat). */
  onChunk?(): Promise<void>;
  log?: typeof logger;
}

export interface StreamRunResult {
  outcome: StreamOutcome;
  /** The offset the run's log rows reach now. */
  consumedBytes: number;
  /** The agent's session id, from any line (replayed ones too). */
  sessionId?: string;
  /** Whether the agent emitted its terminal event (its turn is over). */
  sawTerminal: boolean;
}

const NEWLINE = 0x0a;

/** A complete line and the file offset just past its newline. */
export interface OutputLine {
  text: string;
  end: number;
}

/**
 * Splits a byte stream into complete lines with byte-exact file offsets. A
 * multi-byte character never spans a newline (0x0a appears in UTF-8 only as
 * itself), so each line is decoded on its own and partial lines wait for
 * their newline across chunks. Offsets count bytes, never string length.
 */
export class LineSplitter {
  private pending: Buffer = Buffer.alloc(0);
  /** The file offset of the end of what has been pushed so far. */
  private seen: number;

  constructor(fromByte = 0) {
    this.seen = fromByte;
  }

  push(chunk: Buffer): OutputLine[] {
    const buf = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    const base = this.seen - this.pending.length;
    const lines: OutputLine[] = [];
    let start = 0;
    for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, start)) {
      lines.push({ text: buf.subarray(start, i).toString("utf8"), end: base + i + 1 });
      start = i + 1;
    }
    this.pending = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
    this.seen += chunk.length;
    return lines;
  }

  /** The unterminated tail, as a last line (the agent exited without a final newline). */
  flush(): OutputLine | null {
    if (this.pending.length === 0) return null;
    const line = { text: this.pending.toString("utf8"), end: this.seen };
    this.pending = Buffer.alloc(0);
    return line;
  }
}

/**
 * The one attach loop, for every run kind: attaches to the run's output
 * from byte 0 and streams it to its end. Lines below `consumedBytes` were
 * stored by an earlier attachment: they feed the derivations and nothing
 * else. The rest become log rows, each chunk's batch committed with the new
 * offset in one transaction (`appendRunLogsBatch`), then published. The
 * agent's terminal event closes its stdin (`STDIN_EOF_SENTINEL`) — on a
 * replay too: the feeder stops at the first sentinel, so a second is
 * inert, and an instance that saw the event and died before delivering it
 * must not leave the agent waiting.
 */
export async function streamRun(input: StreamRunInput): Promise<StreamRunResult> {
  const { runtime, handle, ref, runDir, hold } = input;
  const log = input.log ?? logger;
  let consumed = input.consumedBytes;
  let sessionId: string | undefined;
  let sawTerminal = false;
  let taken = false;
  let progressed = false;

  // Shutting down: the run is for another instance to stream.
  if (isDetaching()) {
    return {
      outcome: { kind: "detached", reason: "closed" },
      consumedBytes: consumed,
      sawTerminal,
    };
  }
  hold.phase = "streaming";
  const attachment = await runtime.attachRun(handle, { runId: ref.id, runDir, fromByte: 0 });
  hold.attachment = attachment;
  // Shutdown let the run go while the attach exec was opening: sever it now.
  if (hold.released) attachment.close();
  const splitter = new LineSplitter(0);
  const lost = async (): Promise<StreamRunResult> => ({
    outcome: (await classifyLoss(hold)) === "taken" ? { kind: "taken" } : { kind: "reset" },
    consumedBytes: consumed,
    sawTerminal,
  });

  const handleLines = async (lines: OutputLine[]): Promise<void> => {
    const rows: LogLine[] = [];
    let last = consumed;
    for (const line of lines) {
      const replay = line.end <= consumed;
      input.derive?.(line.text);
      if (line.text.trim()) {
        const parsed = input.parse(line.text);
        if (parsed.sessionId && !sessionId) {
          sessionId = parsed.sessionId;
          if (!replay) await input.onSession?.(sessionId);
        }
        if (parsed.isTerminal && !sawTerminal) {
          sawTerminal = true;
          await runtime
            .deliverStdin(handle, { runId: ref.id, runDir, line: STDIN_EOF_SENTINEL })
            .catch((err) => {
              // Already closed (a replay of a turn whose EOF went in): nothing to do.
              if (err instanceof RunStdinClosedError) return;
              log.warn({ err }, "Failed to close the agent's stdin after its turn");
            });
        }
        if (!replay) {
          input.onEntries?.(parsed.entries);
          for (const entry of parsed.entries) {
            rows.push({
              content: entry.content,
              stream: "stdout",
              logType: entry.type,
              metadata: entry.metadata ?? null,
            });
          }
        }
      }
      if (!replay) last = line.end;
    }
    if (last <= consumed) return;
    const fault =
      rows.find((r) => r.content === STREAM_FAULT) ??
      (hold.origin === "start" ? rows.find((r) => r.content === STREAM_FAULT_FIRST) : undefined);
    if (fault) throw new Error(`test fault: the log write failed at "${fault.content}"`);
    let stored: LogRow[];
    try {
      stored = await appendRunLogsBatch(ref, rows, { from: consumed, to: last }, hold.token);
    } catch (err) {
      if (err instanceof AttachmentLostError) {
        taken = true;
        if (hold instanceof Hold) hold.sever();
        else hold.attachment?.close();
        return;
      }
      throw err;
    }
    consumed = last;
    // An attach job that made progress: the attempt's failed attaches before
    // it were not in a row.
    if (!progressed && hold.origin === "attach") {
      progressed = true;
      await clearAttachFailures(hold);
    }
    for (const row of stored) await input.publish(row);
  };

  try {
    for await (const chunk of attachment.output as AsyncIterable<Buffer>) {
      if (taken || hold.lost) break;
      const lines = splitter.push(chunk);
      if (lines.length > 0) await handleLines(lines);
      if (taken || hold.lost) break;
      await input.onChunk?.();
    }
  } catch (err) {
    if (!taken && !hold.lost) {
      // A failure here (the database, a publish) must not leave the exec open.
      try {
        attachment.close();
      } catch {
        // already closed
      }
      hold.attachment = null;
      throw err;
    }
  }

  const exit = await attachment.exit;
  hold.attachment = null;
  if (taken || hold.lost) return lost();
  // Shutdown let the run go while the exit came in: it is the next
  // instance's to settle (it replays the output to the same verdict).
  if (hold.released) {
    return {
      outcome: { kind: "detached", reason: "closed" },
      consumedBytes: consumed,
      sawTerminal,
    };
  }
  // Past the stream: shutdown waits for this hold to settle the run.
  if (exit.kind === "exited" || exit.kind === "lost") hold.phase = "settling";

  // The agent exited: whatever has no trailing newline is its last line.
  if (exit.kind === "exited") {
    const tail = splitter.flush();
    if (tail) await handleLines([tail]);
    if (taken) return lost();
  }
  return { outcome: exit, consumedBytes: consumed, sessionId, sawTerminal };
}

// ── The attach job: one driver for every run kind ───────────────────────────

/** The pod a run's agent runs in, as the finishing code needs it. */
export interface AttachedPod {
  id: string;
  handle: ContainerHandle;
}

export interface AttachJobSpec {
  ref: AttachRef;
  log: typeof logger;
  /** The `agent_pods` row the run's agent was started in. */
  podId: string | null;
  /**
   * The pod is gone (or not ready): the run is lost with it. Called once
   * the exit is recorded (`settleRun`); settles the run's state the way
   * the kind's pod-death path does.
   */
  onPodGone(detail: string, hold: AttachmentHold): Promise<void>;
  /** Streams the run to its end and settles it: the kind's finishing code. */
  finish(pod: AttachedPod, hold: AttachmentHold, claim: AttachmentClaim): Promise<RunEnd>;
  /**
   * Attach jobs failed the run MAX_ATTACH_FAILURES times in a row: fail it
   * with `message` the way the kind fails a run (its agent is stopped after).
   */
  onAttachFailed(message: string): Promise<void>;
  /** After a run finished (or was reset) here: give back what it held (its pod slot). */
  afterFinish?(podId: string | null): Promise<void>;
}

/**
 * An attach job (the reconciler's `reattach` action), for any run kind:
 * claim the attachment by CAS — losing it is the normal case when two
 * instances answer the same expiry — then finish the run from where its
 * log rows stop. A job of this process that still holds the run makes this
 * one a no-op at once. A pod that is gone settles the run through the
 * kind's pod-death path. The job ends through `endRunJob`, like the one
 * that started the run.
 */
export async function runAttachJob(spec: AttachJobSpec): Promise<RunEnd | "skipped"> {
  const { ref, log } = spec;
  if (isDetaching()) return "skipped";
  if (holdsRun(ref)) {
    log.info("Skipping attach — a job of this instance holds the run");
    return "skipped";
  }
  const claim = await claimAttachment(ref);
  if (!claim) {
    log.info("Skipping attach — the run is attached elsewhere, over, or was never started");
    return "skipped";
  }
  const hold = startHold(ref, claim.token, {
    phase: "streaming",
    origin: "attach",
    agent: spec.podId && claim.pid ? { podId: spec.podId, pid: claim.pid } : null,
  });
  let ended: RunEnd | null = null;
  try {
    const pod = spec.podId ? await podPool.getPod(spec.podId) : null;
    if (!pod || !pod.podName || pod.state !== "ready") {
      const detail = `The pod the agent ran in is ${pod ? pod.state : "gone"}`;
      hold.phase = "settling";
      const settled = await settleRun(hold);
      if (settled === "taken") return (ended = "detached");
      if (settled === "reset") return (ended = "reset");
      await spec.onPodGone(detail, hold);
      await closeAttachment(hold);
      return (ended = "finished");
    }
    log.info({ consumedBytes: claim.consumedBytes, pod: pod.podName }, "Attaching to the run");
    ended = await spec.finish({ id: pod.id, handle: podPool.podHandle(pod) }, hold, claim);
    return ended;
  } catch (err) {
    // Trouble here is this instance's: leave the run for the next attach —
    // or, the attempt's MAX_ATTACH_FAILURES-th failed attach in a row, fail it.
    ended = (await onStreamError(hold, log)) ?? "detached";
    if (ended === "failed") {
      await spec
        .onAttachFailed(attachFailedMessage(err))
        .catch((failErr) => log.warn({ err: failErr }, "Failed to fail the run"));
    }
    throw err;
  } finally {
    await endRunJob(hold, ended, log);
    if (ended === "finished" || ended === "reset" || ended === "failed") {
      await spec.afterFinish?.(spec.podId).catch(() => {});
    }
  }
}

/** Maps a settle that did not settle to the job's end (`taken` → detached). */
export function endOfLoss(loss: HoldLoss): "detached" | "reset" {
  return loss === "taken" ? "detached" : "reset";
}

// ── Pod-side housekeeping ───────────────────────────────────────────────────

/** How much of an agent's stderr is kept: its last 8 KB. */
const STDERR_TAIL_BYTES = 8192;

/**
 * Whether `runDir` is a run directory this module may remove: exactly
 * `/home/agent/optio/runs/<one segment>`, the segment a plain name (no
 * `.` or `..`, no slash, nothing a shell would read twice).
 */
export function isRemovableRunDir(runDir: string): boolean {
  const prefix = `${RUN_HOMES_DIR}/`;
  if (!runDir.startsWith(prefix)) return false;
  const segment = runDir.slice(prefix.length);
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(segment) && segment !== "." && segment !== "..";
}

/** Runs a short script in the pod and returns its stdout (best-effort: "" on failure). */
async function podScript(
  runtime: ContainerRuntime,
  handle: ContainerHandle,
  script: string,
): Promise<string> {
  const session = await runtime.exec(handle, ["bash", "-c", script], { tty: false });
  let out = "";
  try {
    for await (const chunk of session.stdout as AsyncIterable<Buffer | string>) {
      out += chunk.toString();
    }
  } finally {
    session.close();
  }
  return out;
}

const stderrTailScript = (runDir: string) =>
  `if [ -s ${shellQuote(`${runDir}/stderr.log`)} ]; then tail -c ${STDERR_TAIL_BYTES} ${shellQuote(`${runDir}/stderr.log`)}; fi`;

/**
 * The last 8 KB of the run's stderr, read in one short exec — for the
 * failure message of a run that failed, was lost, or produced no output.
 * Best-effort: "" when there is none or it cannot be read.
 */
export async function readRunStderr(
  runtime: ContainerRuntime,
  handle: ContainerHandle,
  runDir: string,
): Promise<string> {
  if (!isRemovableRunDir(runDir)) return "";
  try {
    return (await podScript(runtime, handle, stderrTailScript(runDir))).trim();
  } catch (err) {
    logger.debug({ err, runDir }, "Failed to read the run's stderr");
    return "";
  }
}

const REVIEW_DRAFT_MAX_BYTES = 262144;

/**
 * The review draft the agent wrote in its worktree. Best-effort: "" when
 * there is none — or when the file, or its directory, is a symlink: the
 * agent (or the repo's content) could otherwise point the reader at any file
 * in the pod. The worktree's setup removed whatever was at the path before
 * the agent ran (`clearFiles`), so a file read here is the agent's.
 */
export async function readReviewDraft(
  runtime: ContainerRuntime,
  handle: ContainerHandle,
  worktreeId: string,
): Promise<string> {
  const path = shellQuote(`/workspace/tasks/${worktreeId}/${PR_REVIEW_OUTPUT_PATH}`);
  const dir = shellQuote(`/workspace/tasks/${worktreeId}/${posix.dirname(PR_REVIEW_OUTPUT_PATH)}`);
  try {
    return await podScript(
      runtime,
      handle,
      `if [ ! -L ${dir} ] && [ ! -L ${path} ] && [ -f ${path} ]; then head -c ${REVIEW_DRAFT_MAX_BYTES} ${path}; fi`,
    );
  } catch (err) {
    logger.debug({ err, worktreeId }, "Failed to read the review draft");
    return "";
  }
}

/** A failure message with the agent's stderr tail under it, when it has one. */
export function withStderr(message: string, stderrTail: string): string {
  const tail = stderrTail.trim();
  return tail
    ? `${message}\n\nAgent stderr (last ${STDERR_TAIL_BYTES / 1024} KB):\n${tail}`
    : message;
}

/**
 * Removes the run's directory in its pod once the run is terminal and every
 * byte of its output is a log row (the run-home sweep is the backstop), in
 * one short exec that first reads the tail of the agent's stderr: logged as
 * a warning when there is any, and returned. Best-effort.
 */
export async function removeRunDirectory(
  runtime: ContainerRuntime,
  handle: ContainerHandle,
  runDir: string,
  log: typeof logger = logger,
): Promise<string> {
  if (!isRemovableRunDir(runDir)) return "";
  try {
    const tail = (
      await podScript(runtime, handle, `${stderrTailScript(runDir)}; rm -rf ${shellQuote(runDir)}`)
    ).trim();
    if (tail) log.warn({ stderrTail: tail }, "Agent stderr output");
    return tail;
  } catch (err) {
    logger.debug({ err, runDir }, "Failed to remove run directory");
    return "";
  }
}

/**
 * Signals a run's process group in its pod, from any instance: the pod is
 * found from the database (`podId`), the run directory from the run's id.
 * With `pid`, only that attempt's supervisor is signalled. True when a live
 * supervisor was there to signal. Best-effort.
 */
export async function signalRun(
  podId: string | null | undefined,
  runId: string,
  signal: "TERM" | "KILL" = "TERM",
  opts: { pid?: number } = {},
): Promise<boolean> {
  if (!podId) return false;
  try {
    const pod = await podPool.getPod(podId);
    if (!pod?.podName) return false;
    return await getRuntime().killRun(podPool.podHandle(pod), {
      runId,
      runDir: runHome(runId).podDir,
      signal,
      ...(opts.pid !== undefined && opts.pid > 1 ? { pid: opts.pid } : {}),
    });
  } catch (err) {
    logger.warn({ err, runId }, "Failed to signal the run's process");
    return false;
  }
}
