/**
 * Credential health (docs/credential-health.md): the `credential_checks`
 * rows, one per credential, and who may see which.
 *
 *   - a person: their own (`scope = person`);
 *   - a workspace admin: their workspace's organization credentials (its
 *     gateways' tokens, a GitLab token stored for it);
 *   - a deployment admin: also the deployment-wide ones (a global GitLab
 *     token with no workspace).
 *
 * Nothing here holds a token: a row says what was found, never the value.
 */
import { and, eq, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client.js";
import { credentialChecks } from "../../db/schema.js";
import type { CredentialRef } from "./inventory.js";
import type { CheckOutcome } from "./outcome.js";

export type CredentialCheckRow = typeof credentialChecks.$inferSelect;

export interface HealthViewer {
  userId: string | null;
  workspaceId: string | null;
  isWorkspaceAdmin: boolean;
  deploymentAdmin: boolean;
}

/** The rows `viewer` may see, as SQL. */
export function visibleChecks(viewer: HealthViewer): SQL {
  const terms: SQL[] = [];
  if (viewer.userId) {
    terms.push(
      and(eq(credentialChecks.scope, "person"), eq(credentialChecks.userId, viewer.userId))!,
    );
  }
  if (viewer.isWorkspaceAdmin && viewer.workspaceId) {
    terms.push(
      and(
        eq(credentialChecks.scope, "organization"),
        eq(credentialChecks.workspaceId, viewer.workspaceId),
      )!,
    );
  }
  if (viewer.deploymentAdmin) {
    terms.push(
      and(eq(credentialChecks.scope, "organization"), isNull(credentialChecks.workspaceId))!,
    );
  }
  return terms.length ? or(...terms)! : sql`false`;
}

export interface CredentialCheckView {
  key: string;
  kind: CredentialCheckRow["kind"];
  label: string;
  scope: CredentialCheckRow["scope"];
  status: CredentialCheckRow["status"];
  reason: string | null;
  expiresAt: string | null;
  checkedAt: string;
  details: Record<string, unknown>;
}

/** What a row may show besides its status: never anything that quotes a token. */
const SHOWN_DETAILS = [
  "host",
  "scopes",
  "tokenName",
  "gateway",
  "spend",
  "maxBudget",
  "budgetResetAt",
  "budgetDuration",
  "keyAlias",
] as const;

export function toView(r: CredentialCheckRow): CredentialCheckView {
  const details: Record<string, unknown> = {};
  for (const k of SHOWN_DETAILS) if (r.details?.[k] !== undefined) details[k] = r.details[k];
  return {
    key: r.credentialKey,
    kind: r.kind,
    label: r.label,
    scope: r.scope,
    status: r.status,
    reason: r.reason,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    checkedAt: r.checkedAt.toISOString(),
    details,
  };
}

/** Worst first: error, warning, unknown, ok. */
const statusOrder = () =>
  sql`CASE ${credentialChecks.status} WHEN 'error' THEN 0 WHEN 'warning' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END`;

export async function listChecks(viewer: HealthViewer): Promise<CredentialCheckRow[]> {
  return db
    .select()
    .from(credentialChecks)
    .where(visibleChecks(viewer))
    .orderBy(statusOrder(), credentialChecks.kind, credentialChecks.label);
}

export async function getCheck(key: string): Promise<CredentialCheckRow | null> {
  const [row] = await db
    .select()
    .from(credentialChecks)
    .where(eq(credentialChecks.credentialKey, key));
  return row ?? null;
}

/**
 * Records a check. `notified` replaces the sent markers when given (the
 * pass); the pre-flight leaves them alone.
 */
export async function saveCheck(
  ref: Pick<CredentialRef, "key" | "kind" | "label" | "scope" | "workspaceId" | "userId">,
  outcome: CheckOutcome,
  now: Date,
  notified?: Record<string, string>,
): Promise<CredentialCheckRow> {
  const values = {
    kind: ref.kind,
    label: ref.label,
    scope: ref.scope,
    workspaceId: ref.workspaceId,
    userId: ref.userId,
    status: outcome.status,
    reason: outcome.reason,
    expiresAt: outcome.expiresAt,
    details: outcome.details,
    checkedAt: now,
    updatedAt: now,
  };
  const [row] = await db
    .insert(credentialChecks)
    .values({ credentialKey: ref.key, ...values, notified: notified ?? {} })
    .onConflictDoUpdate({
      target: credentialChecks.credentialKey,
      set: { ...values, ...(notified ? { notified } : {}) },
    })
    .returning();
  return row;
}

/** Drops rows whose credential is gone (not in a full pass that started at `passStart`). */
export async function pruneChecks(seen: string[], passStart: Date): Promise<number> {
  const stale = seen.length
    ? and(
        notInArray(credentialChecks.credentialKey, seen),
        lt(credentialChecks.checkedAt, passStart),
      )
    : lt(credentialChecks.checkedAt, passStart);
  const removed = await db
    .delete(credentialChecks)
    .where(stale)
    .returning({ id: credentialChecks.id });
  return removed.length;
}
