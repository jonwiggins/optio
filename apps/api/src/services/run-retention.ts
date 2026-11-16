/**
 * Retention for what finished work leaves behind (docs/log-retention.md).
 *
 * Off by default: run logs, transcripts and prompts are kept until someone
 * deletes the run, as before. With `OPTIO_RUN_LOG_RETENTION_DAYS=N` (Helm
 * `retention.runLogsDays`), the housekeeping tick (workers/sweep-worker.ts,
 * every 30 s on one replica) removes, for work that finished more than N
 * days ago:
 *
 * - the rows of its logs and transcripts: `task_logs` (tasks, Job runs,
 *   PR-review runs, persistent-agent turns), the messages sent to a task,
 *   an interactive session's chat events, a PR review's chat, a persistent
 *   agent's processed inbox, an Optio Local terminal's transcript and final
 *   screen;
 * - the text of its prompts and results, on rows that stay: a run's prompt,
 *   result summary, error, review comments and Job output; a review run's
 *   prompt, result and error; a turn's prompt, wake payload, summary and
 *   error; a session's first prompt and turn prompts; a terminal's preview.
 *
 * The run rows themselves (title, state, times, cost and tokens), the state
 * history, the usage numbers and the audit trail stay: they say what ran and
 * what it cost, not what it read or printed.
 *
 * "Finished" is a terminal state with its end time past the cutoff, and no
 * agent recorded as started; queued, running and waiting work is never
 * touched, nor is a session that is still active or a run whose PR is
 * still open. Each step deletes or
 * clears at most `RETENTION_BATCH` rows per tick, so locks stay short and a
 * large backlog drains over a few ticks; once a pass finds nothing left it
 * rests for `RETENTION_REST_MS`.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { logger } from "../logger.js";

/** Rows one step deletes or clears per tick. */
export const RETENTION_BATCH = 1000;
/** After a pass that found nothing more, the next one waits this long. */
export const RETENTION_REST_MS = 60 * 60 * 1000;
/** The longest retention accepted (100 years). */
export const RETENTION_MAX_DAYS = 36_500;
const DAY_MS = 86_400_000;

let warnedInvalid = false;

/**
 * `OPTIO_RUN_LOG_RETENTION_DAYS` as whole days, or null for "keep forever":
 * unset, empty, 0, or not a whole number from 1 to RETENTION_MAX_DAYS (an
 * invalid value is logged once and keeps everything, never deletes more).
 */
export function runLogRetentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.OPTIO_RUN_LOG_RETENTION_DAYS ?? "").trim();
  if (raw === "" || raw === "0") return null;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= RETENTION_MAX_DAYS) return n;
  if (!warnedInvalid) {
    warnedInvalid = true;
    logger.warn(
      { value: raw },
      `OPTIO_RUN_LOG_RETENTION_DAYS must be a whole number of days from 1 to ${RETENTION_MAX_DAYS}; keeping run logs`,
    );
  }
  return null;
}

/** A run whose prompt the retention removed: it can't be run again as it was. */
export function isPromptPruned(run: { metadata?: Record<string, unknown> | null }): boolean {
  const retention = run.metadata?.retention as { prunedAt?: unknown } | undefined;
  return typeof retention?.prunedAt === "string";
}

export const PROMPT_PRUNED_MESSAGE =
  "This run's prompt and logs were removed by the retention policy, so it can't run again. Create a new task instead.";

// ── What "finished before the cutoff" means, per kind ──────────────────────

/**
 * A row of the runs table (tasks and Job runs), alias `t`. A run whose PR is
 * still open is still watched (the reconciler may resume it with the PR's
 * review), so it isn't finished yet.
 */
const finishedRun = (cutoff: Date) => sql`
  t.state IN ('completed', 'failed', 'cancelled')
  AND COALESCE(t.completed_at, t.updated_at) < ${cutoff.toISOString()}::timestamptz
  AND t.exec_state IS DISTINCT FROM 'started'
  AND (t.pr_url IS NULL OR t.pr_state IN ('merged', 'closed'))`;

/** A PR-review run, alias `r`. */
const finishedReviewRun = (cutoff: Date) => sql`
  r.state IN ('completed', 'failed', 'cancelled')
  AND COALESCE(r.completed_at, r.updated_at) < ${cutoff.toISOString()}::timestamptz
  AND r.exec_state IS DISTINCT FROM 'started'`;

/** A persistent agent's turn, alias `p`. */
const finishedTurn = (cutoff: Date) => sql`
  p.finished_at IS NOT NULL
  AND p.finished_at < ${cutoff.toISOString()}::timestamptz
  AND p.exec_state IS DISTINCT FROM 'started'`;

/** An interactive session, alias `s`. */
const endedSession = (cutoff: Date) => sql`
  s.state = 'ended' AND s.ended_at IS NOT NULL
  AND s.ended_at < ${cutoff.toISOString()}::timestamptz`;

/** An Optio Local terminal, alias `lt`. */
const endedTerminal = (cutoff: Date) => sql`
  lt.state IN ('exited', 'error')
  AND COALESCE(lt.ended_at, lt.updated_at) < ${cutoff.toISOString()}::timestamptz`;

/** A PR review, alias `pr`, with no run of it still going. */
const settledReview = (cutoff: Date) => sql`
  pr.state IN ('submitted', 'cancelled', 'failed')
  AND pr.updated_at < ${cutoff.toISOString()}::timestamptz
  AND NOT EXISTS (
    SELECT 1 FROM pr_review_runs r2
    WHERE r2.pr_review_id = pr.id AND r2.state IN ('queued', 'provisioning', 'running')
  )`;

type Step = (cutoff: Date, now: Date) => SQL;

/**
 * One statement per store. Each picks at most RETENTION_BATCH rows by key
 * in a subquery and returns one row per row it deleted or cleared. A
 * clearing step only picks rows that still hold something, so a pass
 * that has caught up selects nothing.
 */
const STEPS: Array<[string, Step]> = [
  [
    "run logs",
    (c) => sql`DELETE FROM task_logs WHERE id IN (
      SELECT l.id FROM task_logs l JOIN tasks t ON t.id = l.task_id
      WHERE ${finishedRun(c)} LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "review run logs",
    (c) => sql`DELETE FROM task_logs WHERE id IN (
      SELECT l.id FROM task_logs l JOIN pr_review_runs r ON r.id = l.pr_review_run_id
      WHERE ${finishedReviewRun(c)} LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "turn logs",
    (c) => sql`DELETE FROM task_logs WHERE id IN (
      SELECT l.id FROM task_logs l JOIN persistent_agent_turns p ON p.id = l.persistent_agent_turn_id
      WHERE ${finishedTurn(c)} LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "task messages",
    (c) => sql`DELETE FROM task_messages WHERE id IN (
      SELECT m.id FROM task_messages m JOIN tasks t ON t.id = m.task_id
      WHERE ${finishedRun(c)} LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "session chat events",
    (c) => sql`DELETE FROM session_chat_events WHERE id IN (
      SELECT e.id FROM session_chat_events e JOIN interactive_sessions s ON s.id = e.session_id
      WHERE ${endedSession(c)} LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "review chat",
    (c) => sql`DELETE FROM pr_review_chat_messages WHERE id IN (
      SELECT m.id FROM pr_review_chat_messages m JOIN pr_reviews pr ON pr.id = m.pr_review_id
      WHERE ${settledReview(c)} LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "agent inbox",
    (c) => sql`DELETE FROM persistent_agent_messages WHERE id IN (
      SELECT m.id FROM persistent_agent_messages m
      LEFT JOIN persistent_agent_turns p ON p.id = m.turn_id
      WHERE m.processed_at IS NOT NULL
        AND m.processed_at < ${c.toISOString()}::timestamptz
        AND (m.turn_id IS NULL OR (${finishedTurn(c)}))
      LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "terminal transcripts",
    (c) => sql`DELETE FROM local_terminal_transcripts WHERE (terminal_id, seq) IN (
      SELECT x.terminal_id, x.seq FROM local_terminal_transcripts x
      JOIN local_terminals lt ON lt.id = x.terminal_id
      WHERE ${endedTerminal(c)} LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "terminal screens",
    (c) => sql`DELETE FROM local_terminal_snapshots WHERE terminal_id IN (
      SELECT x.terminal_id FROM local_terminal_snapshots x
      JOIN local_terminals lt ON lt.id = x.terminal_id
      WHERE ${endedTerminal(c)} LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "run prompts",
    // A repo run's prompt is NOT NULL (tasks_repo_check): it becomes "".
    // The marker tells retry and redo that the run can't run again.
    (c, now) => sql`UPDATE tasks SET
        prompt = CASE WHEN kind = 'repo' THEN '' ELSE NULL END,
        result_summary = NULL, error_message = NULL, pr_review_comments = NULL, output = NULL,
        metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('retention', jsonb_build_object('prunedAt', ${now.toISOString()}::text))
      WHERE id IN (
        SELECT t.id FROM tasks t WHERE ${finishedRun(c)}
          AND (COALESCE(t.prompt, '') <> '' OR t.result_summary IS NOT NULL
            OR t.error_message IS NOT NULL OR t.pr_review_comments IS NOT NULL
            OR t.output IS NOT NULL)
        LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "review run prompts",
    (c) => sql`UPDATE pr_review_runs SET prompt = NULL, result_summary = NULL, error_message = NULL
      WHERE id IN (
        SELECT r.id FROM pr_review_runs r WHERE ${finishedReviewRun(c)}
          AND (r.prompt IS NOT NULL OR r.result_summary IS NOT NULL OR r.error_message IS NOT NULL)
        LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "turn prompts",
    (c) => sql`UPDATE persistent_agent_turns
      SET prompt_used = NULL, wake_payload = NULL, summary = NULL, error_message = NULL
      WHERE id IN (
        SELECT p.id FROM persistent_agent_turns p WHERE ${finishedTurn(c)}
          AND (p.prompt_used IS NOT NULL OR p.wake_payload IS NOT NULL
            OR p.summary IS NOT NULL OR p.error_message IS NOT NULL)
        LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "session turn prompts",
    (c) => sql`UPDATE session_chat_turns SET prompt = NULL
      WHERE id IN (
        SELECT ct.id FROM session_chat_turns ct JOIN interactive_sessions s ON s.id = ct.session_id
        WHERE ${endedSession(c)} AND ct.prompt IS NOT NULL
        LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "session prompts",
    (c) => sql`UPDATE interactive_sessions SET initial_prompt = ''
      WHERE id IN (
        SELECT s.id FROM interactive_sessions s WHERE ${endedSession(c)} AND s.initial_prompt <> ''
        LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
  [
    "terminal previews",
    (c) => sql`UPDATE local_terminals SET preview = NULL
      WHERE id IN (
        SELECT lt.id FROM local_terminals lt WHERE ${endedTerminal(c)} AND lt.preview IS NOT NULL
        LIMIT ${RETENTION_BATCH}) RETURNING 1`,
  ],
];

/** When the next pass may start (this process; another replica starts at once). */
let restUntil = 0;

/** Forget the rest period (tests). */
export function resetRetentionRest(): void {
  restUntil = 0;
}

/**
 * One retention step of the housekeeping tick: nothing when retention is
 * off or the last pass caught up less than RETENTION_REST_MS ago;
 * otherwise each store loses at most RETENTION_BATCH rows of finished work
 * older than the retention. Returns how many rows it deleted or cleared.
 */
export async function pruneRunData(
  now: Date = new Date(),
  days: number | null = runLogRetentionDays(),
): Promise<number> {
  if (days === null) return 0;
  if (now.getTime() < restUntil) return 0;
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  let total = 0;
  let more = false;
  for (const [name, step] of STEPS) {
    const rows = await db.execute(step(cutoff, now));
    if (rows.length > 0) logger.debug({ store: name, rows: rows.length }, "Run retention");
    total += rows.length;
    if (rows.length >= RETENTION_BATCH) more = true;
  }
  if (!more) restUntil = now.getTime() + RETENTION_REST_MS;
  return total;
}
