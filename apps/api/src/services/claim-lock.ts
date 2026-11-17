/**
 * Claim locks (docs/plans/scale-out.md §3): the count-then-claim that admits
 * a run under a concurrency limit — "fewer than N running, so take this
 * one" — is only correct when nobody else counts at the same time. One
 * process used to serialize its own claimers with a promise chain; across
 * API instances that is a Postgres transaction-level advisory lock, held for
 * exactly the count and the claim.
 *
 * `withClaimLock(keys, fn)` opens a transaction, takes
 * `pg_advisory_xact_lock(hashtext(key))` for every key in sorted order (two
 * claimers that need the same set of locks take them in the same order, so
 * they can't deadlock), runs `fn`, and releases the locks when the
 * transaction ends. Only the global keys are used — `claim:tasks` for Repo
 * Task runs, `claim:workflows` for Job runs: every claim of a kind takes
 * it, so a repo's (or a Job's) own limit is counted under the global lock
 * too, and a per-repo key would add nothing.
 *
 * `fn` counts on `claim.tx` and makes its claim — a compare-and-swap state
 * transition — on `claim.tx` too (`claimTransitionIn`,
 * `claimWorkflowRunIn`), so the claim commits with the transaction, before
 * the lock is released; the next claimer's count starts after that and,
 * under READ COMMITTED (each statement sees what committed before it
 * started — set explicitly, since a stricter default would make the next
 * claimer count from a snapshot older than the claim it waited for), sees
 * it. What follows a claim (events, webhooks, the reconciler) is
 * registered with `claim.afterCommit` and runs once the transaction has
 * committed; a rollback drops it. Nothing inside `fn` may use the shared
 * `db` client: a claimer holds one pooled connection while it waits for
 * the lock, and a holder that needed a second one could wait forever on a
 * pool that the waiters have exhausted.
 *
 * A claimer waits for the lock at most `lock_timeout` (10 s): past that,
 * `withClaimLock` resolves `null` — "couldn't claim now" — and the worker
 * takes its usual re-queue-with-delay path.
 */
import { sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { logger } from "../logger.js";
import { isLockTimeout } from "../utils/db-errors.js";

/** A transaction handle `withClaimLock` hands to its callback. */
type ClaimTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** What `withClaimLock` hands its callback. */
export interface ClaimContext {
  /** The claim's transaction: count and claim on it, never on `db`. */
  tx: ClaimTx;
  /** Runs `step` once the transaction has committed; dropped on rollback. */
  afterCommit(step: () => unknown): void;
}

/** The global Repo Task limit (`OPTIO_MAX_CONCURRENT`); per-repo limits are counted under it. */
export const TASK_CLAIM_KEY = "claim:tasks";
/** The global Job run limit (`OPTIO_MAX_WORKFLOW_CONCURRENT`); per-Job limits are counted under it. */
export const WORKFLOW_CLAIM_KEY = "claim:workflows";

/** How long a claimer waits for the lock before it gives up for now. */
const CLAIM_LOCK_TIMEOUT = "10s";

/**
 * The lock key for a limit. `hashtext` takes text of any length and hashes
 * it to 32 bits; two keys that collide only serialize with each other,
 * which is harmless.
 */
export function claimKey(...parts: string[]): string {
  const key = parts.join(":");
  if (!key) throw new Error("Invalid claim key: empty");
  return key;
}

/**
 * Runs `fn` while holding the advisory locks for `keys`, inside one
 * transaction, then the steps it registered with `afterCommit`. Returns
 * what `fn` returns, or `null` when the locks weren't free within the lock
 * timeout. A throw rolls the transaction back (the locks and the
 * registered steps go with it).
 */
export async function withClaimLock<T>(
  keys: readonly string[],
  fn: (claim: ClaimContext) => Promise<T>,
): Promise<T | null> {
  const sorted = [...new Set(keys.map((k) => claimKey(k)))].sort();
  if (sorted.length === 0) throw new Error("withClaimLock needs at least one key");
  const afterCommit: Array<() => unknown> = [];
  let result: T;
  try {
    result = await db.transaction(
      async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${CLAIM_LOCK_TIMEOUT}'`));
        for (const key of sorted) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
        }
        return fn({ tx, afterCommit: (step) => void afterCommit.push(step) });
      },
      { isolationLevel: "read committed" },
    );
  } catch (err) {
    if (isLockTimeout(err)) {
      logger.info({ keys: sorted }, "Claim lock busy; not claiming now");
      return null;
    }
    throw err;
  }
  for (const step of afterCommit) {
    try {
      await step();
    } catch (err) {
      logger.warn({ err, keys: sorted }, "A claim's after-commit step failed");
    }
  }
  return result;
}
