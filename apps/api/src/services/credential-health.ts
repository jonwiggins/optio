/**
 * Credential health (docs/credential-health.md): every 15 minutes, one API
 * instance checks each token Optio holds — the organization's, each team's
 * and each person's GitLab token, every gateway token, Jira and remote-workspace
 * connections — records what it found on `credential_checks`, and warns
 * the token's owner by email ahead of an expiry (30, 7 and 1 days) and when
 * a token is refused or over its budget.
 *
 *   services/credential-health/inventory.ts   what there is to check
 *   services/credential-health/checks.ts      asking GitLab, the gateway, Jira, a workspace provider
 *   services/credential-health/outcome.ts     answers → status and reason (pure)
 *   services/credential-health/alerts.ts      which warnings are due, and their email
 *   services/credential-health/store.ts       the rows, and who may see them
 *   services/credential-health/gateway-preflight.ts   the check before a run
 *   workers/credential-health-worker.ts       the 15-minute tick
 *   routes/credential-health.ts               Settings → System health, My tokens
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { teams } from "../db/schema.js";
import { logger } from "../logger.js";
import { underPollerLease } from "./poller-lease.js";
// Email or a chat hook: a warning goes out by either (docs/notifications.md).
import { canNotify } from "./notify.js";
import { delivered, dueAlerts, sendAlert } from "./credential-health/alerts.js";
import {
  credentialByKey,
  listCredentials,
  type CredentialRef,
} from "./credential-health/inventory.js";
import type { CheckOutcome } from "./credential-health/outcome.js";
import {
  canSeeCheck,
  getCheck,
  pruneChecks,
  saveCheck,
  type CredentialCheckRow,
  type HealthViewer,
} from "./credential-health/store.js";

/** Checks run this many at a time: a slow service doesn't hold up the rest for long. */
const CONCURRENCY = 4;

async function teamName(teamId: string | null): Promise<string | null> {
  if (!teamId) return null;
  const [t] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
  return t?.name ?? null;
}

/**
 * Checks one credential, records it, and sends the warnings that are due
 * (when email or a chat hook can carry them; otherwise they stay due for a
 * later pass, and so does one `delivered` says no one got).
 */
export async function checkAndRecord(
  ref: CredentialRef,
  opts: { now?: Date; canEmail?: boolean } = {},
): Promise<CredentialCheckRow> {
  const now = opts.now ?? new Date();
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
  const notified = { ...keep };
  const canEmail = opts.canEmail ?? (await canNotify());
  if (alerts.length && canEmail) {
    const name = await teamName(ref.teamId);
    for (const alert of alerts) {
      const result = await sendAlert(ref, outcome, alert, name, now);
      if (delivered(result)) {
        for (const m of alert.markers) notified[m] = now.toISOString();
      } else {
        logger.warn(
          { credential: ref.key, kind: alert.kind, error: result.error },
          "credential health: warning not delivered; it stays due",
        );
      }
    }
  }
  return saveCheck(ref, outcome, now, notified);
}

export interface PassResult {
  checked: number;
  byStatus: Record<string, number>;
  pruned: number;
}

/** One pass over every credential (the worker's tick, and "Check all"). */
export async function runCredentialHealthPass(
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<PassResult> {
  const started = opts.now ?? new Date();
  const refs = await listCredentials();
  const canEmail = await canNotify();
  const byStatus: Record<string, number> = {};
  let next = 0;
  const worker = async () => {
    while (next < refs.length && !opts.signal?.aborted) {
      const ref = refs[next++];
      try {
        const row = await checkAndRecord(ref, { now: opts.now, canEmail });
        byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      } catch (err) {
        logger.warn({ err, credential: ref.key }, "credential health: check not recorded");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, refs.length) }, worker));
  const pruned = opts.signal?.aborted
    ? 0
    : await pruneChecks(
        refs.map((r) => r.key),
        started,
      );
  logger.info({ checked: refs.length, byStatus, pruned }, "credential health: pass done");
  return { checked: refs.length, byStatus, pruned };
}

/** One pass under the `poller:credential-health` lease: null when another instance runs it. */
export function credentialHealthTick(): Promise<PassResult | null> {
  return underPollerLease("credential-health", (signal) => runCredentialHealthPass({ signal }));
}

/**
 * "Check now" on one credential — also one no pass has recorded yet (a
 * token stored a minute ago). Null when it is gone, or when `viewer` (when
 * given) may not see it: the route answers both with the same 404.
 */
export async function checkCredentialNow(
  key: string,
  viewer?: HealthViewer,
): Promise<CredentialCheckRow | null> {
  const ref = await credentialByKey(key);
  if (!ref || (viewer && !canSeeCheck(ref, viewer))) return null;
  return checkAndRecord(ref);
}

/** "Check mine" on Settings → My tokens: every credential that is `userId`'s own, now. */
export async function checkMyCredentials(userId: string): Promise<CredentialCheckRow[]> {
  const mine = (await listCredentials()).filter((r) => r.scope === "person" && r.userId === userId);
  const rows: CredentialCheckRow[] = [];
  for (const ref of mine) rows.push(await checkAndRecord(ref));
  return rows;
}

export { listChecks, toViews, canSeeCheck, lastCheckedAt } from "./credential-health/store.js";
export type { HealthViewer, CredentialCheckView } from "./credential-health/store.js";
