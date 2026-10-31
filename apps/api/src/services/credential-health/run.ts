/**
 * Credential health (docs/credential-health.md): a pass over the tokens
 * Optio holds. Each credential is checked at most every
 * `OPTIO_CREDENTIAL_CHECK_MINUTES` (15); the housekeeping tick
 * (workers/sweep-worker.ts) runs the pass, which checks the ones that are
 * due, records what it found and sends the warnings that are due
 * (alerts.ts). A person's "Check now" runs it for their own tokens.
 *
 * The pass checks a few at a time and never throws: a check that fails is
 * recorded as `unknown` and tried next time.
 */
import { db } from "../../db/client.js";
import { credentialChecks } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { delivered, dueAlerts, sendAlert } from "./alerts.js";
import { inventory, type CredentialRef } from "./inventory.js";
import type { CheckOutcome } from "./outcome.js";
import { getCheck, pruneChecks, saveCheck, type CredentialCheckRow } from "./store.js";

export function checkIntervalMs(): number {
  const minutes = Number(process.env.OPTIO_CREDENTIAL_CHECK_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 1 ? minutes : 15) * 60_000;
}

/** Off with `OPTIO_CREDENTIAL_HEALTH=false`. */
export function credentialHealthEnabled(): boolean {
  return (process.env.OPTIO_CREDENTIAL_HEALTH ?? "").trim().toLowerCase() !== "false";
}

/** How many credentials one tick checks at most. */
const BATCH = 50;

export interface PassResult {
  checked: number;
  alerted: number;
  pruned: number;
}

/** Check one credential, record it, and send what is due. */
export async function checkOne(
  ref: CredentialRef,
  now: Date,
  opts: { alert?: boolean } = {},
): Promise<{ row: CredentialCheckRow; alerted: number }> {
  let outcome: CheckOutcome;
  try {
    outcome = await ref.check(now);
  } catch (err) {
    outcome = {
      status: "unknown",
      reason: `The check failed: ${err instanceof Error ? err.message : String(err)}`,
      expiresAt: null,
      details: {},
    };
  }
  const previous = await getCheck(ref.key);
  const { alerts, keep } = dueAlerts(previous?.notified ?? {}, outcome, now);
  let alerted = 0;
  if (opts.alert !== false) {
    for (const alert of alerts) {
      const result = await sendAlert(ref, outcome, alert, now).catch((err) => {
        logger.warn({ err, key: ref.key }, "credential health: couldn't send a warning");
        return null;
      });
      if (result && delivered(result)) {
        for (const m of alert.markers) keep[m] = now.toISOString();
        alerted++;
      }
    }
  }
  const row = await saveCheck(ref, outcome, now, keep);
  return { row, alerted };
}

/**
 * One pass: the credentials whose last check is older than the interval
 * (all with `force`), at most `BATCH`. Rows of credentials that no longer
 * exist are dropped.
 */
export async function runCredentialPass(
  opts: { now?: Date; force?: boolean } = {},
): Promise<PassResult> {
  const now = opts.now ?? new Date();
  const result: PassResult = { checked: 0, alerted: 0, pruned: 0 };
  const refs = await inventory();
  const seen = refs.map((r) => r.key);
  const fresh = new Set(
    opts.force
      ? []
      : (
          await db
            .select({ key: credentialChecks.credentialKey, at: credentialChecks.checkedAt })
            .from(credentialChecks)
        )
          .filter((r) => r.at.getTime() > now.getTime() - checkIntervalMs())
          .map((r) => r.key),
  );
  for (const ref of refs.filter((r) => !fresh.has(r.key)).slice(0, BATCH)) {
    const { alerted } = await checkOne(ref, now);
    result.checked++;
    result.alerted += alerted;
  }
  // A row last checked before this interval whose credential is gone.
  result.pruned = await pruneChecks(seen, new Date(now.getTime() - checkIntervalMs()));
  return result;
}

/** The housekeeping sweep: answers how many rows it pruned. */
export async function credentialHealthSweep(): Promise<number> {
  if (!credentialHealthEnabled()) return 0;
  const r = await runCredentialPass();
  if (r.checked) logger.info(r, "credential health: checked");
  return r.pruned;
}

/** The least time between two "Check now" of one person's tokens. */
const CHECK_NOW_MIN_MS = 60_000;

/**
 * "Check now" on Settings → My tokens: the viewer's own tokens, at once
 * (no more than once a minute; the warnings still go out once). Answers the
 * rows written.
 */
export async function checkMine(userId: string, now = new Date()): Promise<CredentialCheckRow[]> {
  const refs = await inventory({ userId });
  const rows: CredentialCheckRow[] = [];
  for (const ref of refs) {
    const previous = await getCheck(ref.key);
    if (previous && previous.checkedAt.getTime() > now.getTime() - CHECK_NOW_MIN_MS) {
      rows.push(previous);
      continue;
    }
    rows.push((await checkOne(ref, now)).row);
  }
  return rows;
}
