/**
 * The run-home sweep (docs/plans/scale-out.md §1, "Where things live"): the
 * backstop that removes `/home/agent/optio/runs/<run id>` directories of
 * finished runs from every ready pod. The attached worker removes a run's
 * directory itself once the run is terminal and its output consumed; this
 * sweep catches what a worker that died never got to, and the directories
 * of runs that never used the protocol (the exec path, which has nothing to
 * drain). A run home carries the run's setup files, some sensitive, so no
 * finished run's directory outlives the sweep's cycle.
 */
import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { shellQuote } from "@optio/shared";
import { db } from "../db/client.js";
import {
  agentPods,
  sessionChatTurns,
  persistentAgentTurns,
  prReviewRuns,
  workRuns,
} from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import { podHandle } from "./agent-pod-pool.js";
import { RUN_HOMES_DIR } from "../utils/harness-config.js";
import { logger } from "../logger.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** A terminal run whose output was never drained is still removed after this long. */
const UNDRAINED_GRACE_MS = 60 * 60_000;

const TERMINAL_TASK_STATES = ["completed", "failed", "cancelled"] as const;
const TERMINAL_REVIEW_RUN_STATES = ["completed", "failed", "cancelled"] as const;

/** Reads a whole stream as a string. */
function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    stream.on("data", (c: Buffer | string) => (buf += c.toString()));
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
}

/** `ls` of the pod's run homes with each output file's size: `<id> <bytes>` per line. */
const LIST_RUN_HOMES = [
  `for d in ${RUN_HOMES_DIR}/*; do`,
  `  [ -d "$d" ] || continue`,
  `  printf '%s %s\\n' "$(basename "$d")" "$(stat -c %s "$d/output.ndjson" 2>/dev/null || echo 0)"`,
  `done`,
].join("\n");

export interface RunHomeEntry {
  runId: string;
  outputBytes: number;
}

export function parseRunHomeList(text: string): RunHomeEntry[] {
  const out: RunHomeEntry[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const [id, bytes] = parts;
    if (!SAFE_RUN_ID.test(id)) continue;
    out.push({ runId: id, outputBytes: Number.parseInt(bytes, 10) || 0 });
  }
  return out;
}

interface FinishedRun {
  id: string;
  /** Whether the run went through the protocol (an attached worker drains it). */
  protocol: boolean;
  consumedBytes: number;
  finishedAt: Date | null;
}

/** Which of the given ids are finished runs, across every run table. */
async function finishedRuns(ids: string[]): Promise<Map<string, FinishedRun>> {
  const found = new Map<string, FinishedRun>();
  if (ids.length === 0) return found;
  const tasks = await db
    .select({
      id: workRuns.id,
      execState: workRuns.execState,
      consumedBytes: workRuns.consumedBytes,
      completedAt: workRuns.completedAt,
      updatedAt: workRuns.updatedAt,
    })
    .from(workRuns)
    .where(and(inArray(workRuns.id, ids), inArray(workRuns.state, [...TERMINAL_TASK_STATES])));
  for (const t of tasks) {
    found.set(t.id, {
      id: t.id,
      protocol: t.execState !== null,
      consumedBytes: Number(t.consumedBytes ?? 0),
      finishedAt: t.completedAt ?? t.updatedAt,
    });
  }
  const reviews = await db
    .select({
      id: prReviewRuns.id,
      execState: prReviewRuns.execState,
      consumedBytes: prReviewRuns.consumedBytes,
      completedAt: prReviewRuns.completedAt,
      updatedAt: prReviewRuns.updatedAt,
    })
    .from(prReviewRuns)
    .where(
      and(
        inArray(prReviewRuns.id, ids),
        inArray(prReviewRuns.state, [...TERMINAL_REVIEW_RUN_STATES]),
      ),
    );
  for (const r of reviews) {
    found.set(r.id, {
      id: r.id,
      protocol: r.execState !== null,
      consumedBytes: Number(r.consumedBytes ?? 0),
      finishedAt: r.completedAt ?? r.updatedAt,
    });
  }
  const turns = await db
    .select({
      id: persistentAgentTurns.id,
      execState: persistentAgentTurns.execState,
      consumedBytes: persistentAgentTurns.consumedBytes,
      finishedAt: persistentAgentTurns.finishedAt,
    })
    .from(persistentAgentTurns)
    .where(and(inArray(persistentAgentTurns.id, ids), isNotNull(persistentAgentTurns.finishedAt)));
  for (const t of turns) {
    found.set(t.id, {
      id: t.id,
      protocol: t.execState !== null,
      consumedBytes: Number(t.consumedBytes ?? 0),
      finishedAt: t.finishedAt,
    });
  }
  const sessions = await db
    .select({ id: sessionChatTurns.id, finishedAt: sessionChatTurns.finishedAt })
    .from(sessionChatTurns)
    .where(
      and(
        inArray(sessionChatTurns.id, ids),
        inArray(sessionChatTurns.state, ["completed", "interrupted"]),
      ),
    );
  for (const turn of sessions)
    found.set(turn.id, {
      id: turn.id,
      protocol: false,
      consumedBytes: 0,
      finishedAt: turn.finishedAt,
    });
  return found;
}

/** Whether a finished run's home may go: drained, never protocol, or finished long ago. */
export function removable(run: FinishedRun, outputBytes: number, now = Date.now()): boolean {
  if (!run.protocol) return true;
  if (run.consumedBytes >= outputBytes) return true;
  return run.finishedAt !== null && now - run.finishedAt.getTime() > UNDRAINED_GRACE_MS;
}

/**
 * Sweeps every ready pod once. Returns how many run homes were removed.
 * Unknown directories (no run row at all) are left alone.
 */
export async function sweepFinishedRunHomes(): Promise<number> {
  const pods = await db
    .select()
    .from(agentPods)
    .where(and(sql`${agentPods.state} = 'ready'`, isNotNull(agentPods.podName)));
  const rt = getRuntime();
  let removed = 0;
  for (const pod of pods) {
    const handle = podHandle(pod);
    let listing: string;
    try {
      const session = await rt.exec(handle, ["bash", "-c", LIST_RUN_HOMES], { tty: false });
      listing = await collect(session.stdout);
    } catch (err) {
      logger.debug({ err, pod: pod.podName }, "Run-home sweep: could not list the pod's run homes");
      continue;
    }
    const entries = parseRunHomeList(listing);
    if (entries.length === 0) continue;
    const finished = await finishedRuns(entries.map((e) => e.runId));
    const gone = entries.filter((e) => {
      const run = finished.get(e.runId);
      return run !== undefined && removable(run, e.outputBytes);
    });
    if (gone.length === 0) continue;
    const script = gone
      .map((e) => `rm -rf ${shellQuote(`${RUN_HOMES_DIR}/${e.runId}`)}`)
      .join("\n");
    try {
      const session = await rt.exec(handle, ["bash", "-c", script], { tty: false });
      await collect(session.stdout);
      removed += gone.length;
      logger.info(
        { pod: pod.podName, runIds: gone.map((e) => e.runId) },
        "Run-home sweep: removed finished runs' directories",
      );
    } catch (err) {
      logger.warn({ err, pod: pod.podName }, "Run-home sweep: could not remove run homes");
    }
  }
  return removed;
}
