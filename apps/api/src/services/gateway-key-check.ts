import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { gatewayIssuedKeys, users, workspaceMembers } from "../db/schema.js";
import { logger } from "../logger.js";
import { carriedTotal, carryDue } from "./gateway-key-carry.js";
import { keyDriver } from "./gateway-admin.js";
import { keyValueHash, type GatewayKeyDriver } from "./gateway-admin-http.js";
import {
  gatewayAdminOf,
  gatewayKeyIdOf,
  keySecretValue,
  keySpendOf,
  retireKey,
} from "./gateway-keys.js";
import { getModelProviderRow, type ModelProviderRow } from "./model-provider-service.js";
import { logAction } from "./optio-action-service.js";

/**
 * The housekeeping check over the keys Optio made on gateways
 * (docs/model-gateway.md "Keys Optio makes"), every
 * `OPTIO_GATEWAY_KEY_CHECK_MINUTES` (10) per key, on the housekeeping tick
 * (workers/sweep-worker.ts `registerSweep`):
 *
 * - a key whose person is gone or disabled, is no longer in the gateway's
 *   workspace, or pasted another token over it is blocked or deleted on the
 *   gateway (a
 *   failure is tried again next time);
 * - a key that carries spend from an earlier key whose period has ended
 *   gets that amount taken off (LiteLLM: off its spend; OpenRouter: back on
 *   its limit; gateway-key-carry.ts);
 * - otherwise the gateway's spend for it (LiteLLM `/key/info`, OpenRouter
 *   `/keys/{hash}`) is saved for the admin's key list and the next carry.
 *
 * Reading the key's token can fail (the database, a value that won't
 * decrypt): that counts as a failed check, tried again next time, never as
 * "replaced", since deleting a key on the gateway can't be undone.
 */

type IssuedRow = typeof gatewayIssuedKeys.$inferSelect;

const BATCH = 200;
/** A key just made or rotated is left alone this long (its token may not be written yet). */
const GRACE_MS = 2 * 60_000;

export function checkIntervalMs(): number {
  const minutes = Number(process.env.OPTIO_GATEWAY_KEY_CHECK_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 1 ? minutes : 10) * 60_000;
}

/** Why the key should go, or null when it is still its owner's. Throws when the token can't be read. */
async function goneReason(
  row: IssuedRow,
): Promise<{ reason: string; how: "block" | "delete" } | null> {
  if (!row.userId) return { reason: "its owner was deleted", how: "block" };
  const [owner] = await db
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, row.userId));
  if (!owner) return { reason: "its owner was deleted", how: "block" };
  // Offboarding (services/offboarding.ts) disables a person: their keys go too.
  if (owner.disabledAt) return { reason: "its owner was disabled", how: "block" };
  if (row.workspaceId) {
    const [member] = await db
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, row.workspaceId),
          eq(workspaceMembers.userId, row.userId),
        ),
      );
    if (!member) return { reason: "its owner left the workspace", how: "block" };
  }
  // null only when there is no token: any other failure throws (keySecretValue).
  const value = await keySecretValue(row);
  if (value === null || keyValueHash(value) !== row.keyHash) {
    return { reason: "replaced by another token", how: "delete" };
  }
  return null;
}

/**
 * Take what a key carried from an earlier key off it on the gateway once
 * that key's period is over (gateway-key-carry.ts). The gateway first, then
 * the row: a failure in between takes it off once more at worst (LiteLLM;
 * setting OpenRouter's limit again is the same either way).
 */
async function settleCarry(row: IssuedRow, driver: GatewayKeyDriver, now: Date): Promise<void> {
  const due = carryDue(row, now);
  if (!due) return;
  const maxBudget = row.maxBudget === null ? null : Number(row.maxBudget);
  await driver.releaseCarried(gatewayKeyIdOf(row), {
    takeOff: due.takeOff,
    stillCarried: carriedTotal(due.keep),
    maxBudget: maxBudget !== null && Number.isFinite(maxBudget) ? maxBudget : null,
  });
  await db
    .update(gatewayIssuedKeys)
    .set({ carriedSpend: due.keep.length ? due.keep : null })
    .where(eq(gatewayIssuedKeys.id, row.id));
}

export interface KeyCheckResult {
  checked: number;
  revoked: number;
  failed: number;
}

/**
 * One pass over the active keys whose last check is older than the interval
 * (all of them with `force`). Never throws; answers what it did.
 */
export async function checkGatewayKeys(
  opts: { now?: Date; force?: boolean } = {},
): Promise<KeyCheckResult> {
  const now = opts.now ?? new Date();
  const result: KeyCheckResult = { checked: 0, revoked: 0, failed: 0 };
  const due = opts.force
    ? undefined
    : or(
        isNull(gatewayIssuedKeys.checkedAt),
        lt(gatewayIssuedKeys.checkedAt, new Date(now.getTime() - checkIntervalMs())),
      );
  const rows = await db
    .select()
    .from(gatewayIssuedKeys)
    .where(
      and(
        eq(gatewayIssuedKeys.status, "active"),
        lt(gatewayIssuedKeys.updatedAt, new Date(now.getTime() - (opts.force ? 0 : GRACE_MS))),
        ...(due ? [due] : []),
      ),
    )
    .orderBy(sql`${gatewayIssuedKeys.checkedAt} ASC NULLS FIRST`)
    .limit(BATCH);
  const providers = new Map<string, ModelProviderRow | null>();
  for (const row of rows) {
    result.checked++;
    try {
      if (!providers.has(row.providerId)) {
        providers.set(row.providerId, await getModelProviderRow(row.providerId));
      }
      const provider = providers.get(row.providerId);
      if (!provider) continue;
      const admin = gatewayAdminOf(provider);
      const driver = admin ? keyDriver(admin) : null;
      const gone = await goneReason(row);
      if (gone) {
        if (!admin) {
          // Without the admin key Optio can't block it; an admin is told on the key list.
          await markChecked(row.id, now);
          continue;
        }
        await retireKey(row, gone.how, gone.reason, admin);
        result.revoked++;
        logAction({
          workspaceId: row.workspaceId,
          userId: undefined,
          action: "gateway_key.revoke",
          params: {
            id: row.providerId,
            targetUserId: row.userId ?? undefined,
            keyAlias: row.keyAlias,
            reason: gone.reason,
          },
          success: true,
        }).catch(() => {});
        continue;
      }
      if (driver) await settleCarry(row, driver, now);
      const spend = driver ? await keySpendOf(driver, row, now) : null;
      if (!spend) {
        await markChecked(row.id, now);
        continue;
      }
      await db
        .update(gatewayIssuedKeys)
        .set({
          spendUsd: String(spend.spend),
          maxBudget: spend.maxBudget === null ? row.maxBudget : String(spend.maxBudget),
          budgetResetAt: spend.budgetResetAt ? new Date(spend.budgetResetAt) : null,
          checkedAt: now,
        })
        .where(eq(gatewayIssuedKeys.id, row.id));
    } catch (err) {
      result.failed++;
      logger.warn({ err: String(err), keyId: row.id }, "gateway key check failed");
      await markChecked(row.id, now).catch(() => {});
    }
  }
  return result;
}

async function markChecked(id: string, now: Date) {
  await db.update(gatewayIssuedKeys).set({ checkedAt: now }).where(eq(gatewayIssuedKeys.id, id));
}

/** The housekeeping sweep: answers how many keys it revoked (logged when non-zero). */
export async function gatewayKeySweep(): Promise<number> {
  const r = await checkGatewayKeys();
  if (r.failed) logger.info(r, "gateway keys checked");
  return r.revoked;
}
