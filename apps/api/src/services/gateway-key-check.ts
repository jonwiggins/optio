import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { GATEWAY_BUDGET_EXCEEDED_AT, GATEWAY_BUDGET_WARN_AT } from "@optio/shared";
import { db } from "../db/client.js";
import { gatewayIssuedKeys, teams, users, workspaceMembers } from "../db/schema.js";
import { logger } from "../logger.js";
import { auditEvent } from "./audit.js";
import { carriedTotal, carryDue } from "./gateway-key-carry.js";
import { keyDriver } from "./gateway-admin.js";
import { keyValueHash, type GatewayKeyDriver, type GatewaySpend } from "./gateway-admin-http.js";
import {
  budgetFraction,
  gatewayAdminOf,
  gatewayKeyIdOf,
  keySecretValue,
  keySpendOf,
  retireKey,
} from "./gateway-keys.js";
import { getModelProviderRow, type ModelProviderRow } from "./model-provider-service.js";
import { notify } from "./notify.js";

/**
 * The housekeeping check over the keys Optio made on gateways
 * (docs/model-gateway.md "Keys Optio makes"), every
 * `OPTIO_GATEWAY_KEY_CHECK_MINUTES` (10) per key, on the housekeeping tick
 * (workers/sweep-worker.ts):
 *
 * - a person's key whose person is gone, no longer in the gateway's
 *   workspace, or who pasted another token over it — and a team's key whose
 *   team is gone or whose token was replaced — is blocked or deleted on the
 *   gateway (a failure is tried again next time);
 * - a key that carries spend from an earlier key whose period has ended
 *   gets that amount taken off (LiteLLM: off its spend; OpenRouter: back on
 *   its limit; gateway-key-carry.ts);
 * - otherwise the gateway's spend for it (LiteLLM `/key/info`, `/team/info`
 *   for a team; OpenRouter `/keys/{hash}`) is saved, and at 80% and 100% of
 *   its budget the owner (a person's key) or the team's admins (a team's)
 *   get `budget.warning` / `budget.exceeded`, once per budget period. A
 *   gateway that doesn't report a key's spend (Portkey) sends none.
 *
 * Reading the key's secret can fail (the database, a value that won't
 * decrypt): that counts as a failed check, tried again next time, never as
 * "replaced" — deleting a key on the gateway can't be undone.
 */

type IssuedRow = typeof gatewayIssuedKeys.$inferSelect;

const BATCH = 200;
/** A key just made or rotated is left alone this long (its secret may not be written yet). */
const GRACE_MS = 2 * 60_000;

export function checkIntervalMs(): number {
  const minutes = Number(process.env.OPTIO_GATEWAY_KEY_CHECK_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 1 ? minutes : 10) * 60_000;
}

/** Why the key should go, or null when it is still its owner's. Throws when the secret can't be read. */
async function goneReason(
  row: IssuedRow,
): Promise<{ reason: string; how: "block" | "delete" } | null> {
  if (row.kind === "person") {
    if (!row.userId) return { reason: "its owner was deleted", how: "block" };
    // A disabled owner's key goes too (offboarding, services/offboarding.ts).
    const [owner] = await db
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, row.userId));
    if (!owner) return { reason: "its owner was deleted", how: "block" };
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
  } else if (!row.teamId) {
    return { reason: "its team was deleted", how: "delete" };
  }
  // null only when there is no secret: any other failure throws (keySecretValue).
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

function money(n: number): string {
  return `${n.toFixed(2)} USD`;
}

function resetLine(spend: GatewaySpend): string {
  return spend.budgetResetAt
    ? ` It resets on ${new Date(spend.budgetResetAt).toUTCString().slice(0, 16)}.`
    : "";
}

/** The warning to send for this spend, if one is due: the level reached, once per period. */
export function warningDue(
  row: Pick<IssuedRow, "warnedLevel" | "warnedPeriod">,
  spend: Pick<GatewaySpend, "spend" | "maxBudget" | "budgetResetAt">,
):
  | { level: 80 | 100; nextLevel: number; period: string }
  | { level: null; nextLevel: number; period: string } {
  const period = spend.budgetResetAt ?? "";
  // A new budget period (the reset time moved) starts the warnings over.
  const warned = (row.warnedPeriod ?? "") === period ? row.warnedLevel : 0;
  const fraction = budgetFraction(spend.spend, spend.maxBudget);
  if (fraction === null) return { level: null, nextLevel: warned, period };
  if (fraction >= GATEWAY_BUDGET_EXCEEDED_AT && warned < 100)
    return { level: 100, nextLevel: 100, period };
  if (fraction >= GATEWAY_BUDGET_WARN_AT && fraction < GATEWAY_BUDGET_EXCEEDED_AT && warned < 80) {
    return { level: 80, nextLevel: 80, period };
  }
  return { level: null, nextLevel: warned, period };
}

async function sendWarning(
  row: IssuedRow,
  provider: ModelProviderRow,
  spend: GatewaySpend,
  level: 80 | 100,
): Promise<void> {
  const kind = level === 100 ? "budget.exceeded" : "budget.warning";
  const used = `${money(spend.spend)} of ${money(spend.maxBudget ?? 0)}`;
  if (row.kind === "person" && row.userId) {
    await notify({
      kind,
      toUserIds: [row.userId],
      workspaceId: row.workspaceId,
      subject:
        level === 100
          ? `Your gateway key has used its whole budget`
          : `Your gateway key has used ${level}% of its budget`,
      body:
        `Your key ${row.keyAlias ?? ""} for ${provider.name} has spent ${used}.` +
        resetLine(spend) +
        (level === 100
          ? " The gateway refuses your runs until the budget resets or an admin raises it."
          : " When it reaches the budget, the gateway refuses your runs until it resets."),
      link: "/settings#my-tokens",
    });
    return;
  }
  if (row.kind === "team" && row.teamId) {
    const [team] = await db
      .select({ name: teams.name })
      .from(teams)
      .where(eq(teams.id, row.teamId));
    const name = team?.name ?? "The team";
    await notify({
      kind,
      toTeamAdminsOf: row.teamId,
      workspaceId: row.workspaceId,
      subject:
        level === 100
          ? `${name} has used its whole gateway budget`
          : `${name} has used ${level}% of its gateway budget`,
      body:
        `${name}'s budget on ${provider.name} has spent ${used}.` +
        resetLine(spend) +
        (level === 100
          ? " The gateway refuses the team's runs until the budget resets or a team admin raises it."
          : " When it reaches the budget, the gateway refuses the team's runs until it resets."),
      link: `/teams/${row.teamId}`,
    });
  }
}

export interface KeyCheckResult {
  checked: number;
  revoked: number;
  warned: number;
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
  const result: KeyCheckResult = { checked: 0, revoked: 0, warned: 0, failed: 0 };
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
          await markChecked(row.id, now);
          continue;
        }
        await retireKey(row, gone.how, gone.reason, admin);
        result.revoked++;
        void auditEvent({
          userId: null,
          workspaceId: row.workspaceId,
          action: "gateway_key.revoke",
          details: {
            id: row.providerId,
            scope: row.kind === "team" ? "team" : "user",
            teamId: row.teamId ?? undefined,
            targetUserId: row.userId ?? undefined,
            keyAlias: row.keyAlias,
            reason: gone.reason,
          },
        });
        continue;
      }
      // A person's key carries spend; a team's too where the gateway has no teams.
      if (driver && (row.kind === "person" || !driver.teams)) {
        await settleCarry(row, driver, now);
      }
      const spend = driver
        ? row.kind === "team" && driver.teams
          ? row.litellmTeamId && driver.teamSpend
            ? await driver.teamSpend(row.litellmTeamId)
            : null
          : await keySpendOf(driver, row, now)
        : null;
      if (!spend) {
        await markChecked(row.id, now);
        continue;
      }
      const due = warningDue(row, spend);
      if (due.level) {
        await sendWarning(row, provider, spend, due.level);
        result.warned++;
      }
      await db
        .update(gatewayIssuedKeys)
        .set({
          spendUsd: String(spend.spend),
          maxBudget: spend.maxBudget === null ? row.maxBudget : String(spend.maxBudget),
          budgetResetAt: spend.budgetResetAt ? new Date(spend.budgetResetAt) : null,
          warnedLevel: due.nextLevel,
          warnedPeriod: due.period,
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
  if (r.warned || r.failed) logger.info(r, "gateway keys checked");
  return r.revoked;
}
