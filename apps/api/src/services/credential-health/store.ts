/**
 * Credential health (docs/credential-health.md): the `credential_checks`
 * rows — one per credential — and who may see which.
 *
 * Who sees a row (the System health page, `GET /api/credential-health`):
 *
 *   - a deployment admin: every row;
 *   - a person: their own (`scope = person`, also on Settings → My tokens);
 *   - a team admin: their teams' rows;
 *   - a workspace admin: what their workspace's admins manage
 *     (`workspaceManaged`): the organization's Jira and remote-workspace connections of
 *     their workspace, and the shared token stored on one of its gateways.
 *     The organization's GitLab and gateway tokens are deployment-wide
 *     secrets: deployment admins only.
 *
 * Nothing here holds a token: a row says what was found, never the value.
 */
import { and, eq, inArray, like, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client.js";
import { credentialChecks, teams, users } from "../../db/schema.js";
import type { CredentialRef } from "./inventory.js";
import type { CheckOutcome } from "./outcome.js";

export type CredentialCheckRow = typeof credentialChecks.$inferSelect;

export interface HealthViewer {
  userId: string | null;
  workspaceId: string | null;
  /** A workspace admin of `workspaceId`. */
  isWorkspaceAdmin: boolean;
  adminTeamIds: string[];
  deploymentAdmin: boolean;
}

/** A row, or a credential no pass has recorded yet (its `key`). */
export type CheckSubject = Pick<
  CredentialCheckRow,
  "scope" | "userId" | "teamId" | "workspaceId" | "kind"
> &
  ({ credentialKey: string } | { key: string });

/** A gateway's shared token (`tokenSource: stored`), kept on the gateway itself. */
const STORED_GATEWAY_KEY = /^gateway:[^:]+:stored$/;

/**
 * An organization credential one workspace's admins manage: that
 * workspace's Jira and remote-workspace connections, and the shared token of one of
 * its gateways (Settings → Model gateway, which workspace admins edit).
 * They see it on System health and hear about it (alerts.ts).
 */
export function workspaceManaged(row: CheckSubject): boolean {
  if (row.scope !== "organization" || !row.workspaceId) return false;
  if (row.kind === "jira" || row.kind === "remote_workspace") return true;
  const key = "credentialKey" in row ? row.credentialKey : row.key;
  return row.kind === "gateway" && STORED_GATEWAY_KEY.test(key);
}

/** The row form of the rule above. */
export function canSeeCheck(row: CheckSubject, viewer: HealthViewer): boolean {
  if (viewer.deploymentAdmin) return true;
  if (row.scope === "person") return !!viewer.userId && row.userId === viewer.userId;
  if (row.scope === "team") return !!row.teamId && viewer.adminTeamIds.includes(row.teamId);
  return (
    viewer.isWorkspaceAdmin &&
    !!viewer.workspaceId &&
    row.workspaceId === viewer.workspaceId &&
    workspaceManaged(row)
  );
}

/** The SQL form of the rule (undefined = every row). */
export function visibleChecks(viewer: HealthViewer): SQL | undefined {
  if (viewer.deploymentAdmin) return undefined;
  const terms: SQL[] = [];
  if (viewer.userId) {
    terms.push(
      and(eq(credentialChecks.scope, "person"), eq(credentialChecks.userId, viewer.userId))!,
    );
  }
  if (viewer.adminTeamIds.length) {
    terms.push(
      and(
        eq(credentialChecks.scope, "team"),
        inArray(credentialChecks.teamId, viewer.adminTeamIds),
      )!,
    );
  }
  if (viewer.isWorkspaceAdmin && viewer.workspaceId) {
    // workspaceManaged, in SQL.
    terms.push(
      and(
        eq(credentialChecks.scope, "organization"),
        eq(credentialChecks.workspaceId, viewer.workspaceId),
        or(
          inArray(credentialChecks.kind, ["jira", "remote_workspace"]),
          and(
            eq(credentialChecks.kind, "gateway"),
            like(credentialChecks.credentialKey, "gateway:%:stored"),
          ),
        ),
      )!,
    );
  }
  return terms.length ? or(...terms) : sql`false`;
}

export interface CredentialCheckView {
  key: string;
  kind: CredentialCheckRow["kind"];
  label: string;
  scope: CredentialCheckRow["scope"];
  /** Whose: the person's or team's name, or "Organization". */
  owner: { name: string; userId: string | null; teamId: string | null };
  status: CredentialCheckRow["status"];
  reason: string | null;
  expiresAt: string | null;
  checkedAt: string;
  details: Record<string, unknown>;
}

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
  "account",
  "server",
  "version",
  "webhookProjects",
] as const;

/** Rows for the page, with owner names; the details on an allowlist. */
export async function toViews(rows: CredentialCheckRow[]): Promise<CredentialCheckView[]> {
  const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
  const teamIds = [...new Set(rows.map((r) => r.teamId).filter((v): v is string => !!v))];
  const people = userIds.length
    ? await db
        .select({ id: users.id, name: users.displayName, email: users.email })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const teamRows = teamIds.length
    ? await db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(inArray(teams.id, teamIds))
    : [];
  const personName = new Map(people.map((p) => [p.id, p.name || p.email]));
  const teamName = new Map(teamRows.map((t) => [t.id, t.name]));
  return rows.map((r) => {
    const details: Record<string, unknown> = {};
    for (const k of SHOWN_DETAILS) if (r.details?.[k] !== undefined) details[k] = r.details[k];
    return {
      key: r.credentialKey,
      kind: r.kind,
      label: r.label,
      scope: r.scope,
      owner: {
        name:
          r.scope === "person"
            ? (personName.get(r.userId ?? "") ?? "Someone")
            : r.scope === "team"
              ? `Team · ${teamName.get(r.teamId ?? "") ?? "a team"}`
              : "Organization",
        userId: r.userId,
        teamId: r.teamId,
      },
      status: r.status,
      reason: r.reason,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      checkedAt: r.checkedAt.toISOString(),
      details,
    };
  });
}

/** Worst first: error, warning, unknown, ok. */
const statusOrder = () =>
  sql`CASE ${credentialChecks.status} WHEN 'error' THEN 0 WHEN 'warning' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END`;

/** What `viewer` may see, worst first; `mine` = their own only. */
export async function listChecks(
  viewer: HealthViewer,
  opts: { mine?: boolean } = {},
): Promise<CredentialCheckRow[]> {
  const where = opts.mine
    ? viewer.userId
      ? and(eq(credentialChecks.scope, "person"), eq(credentialChecks.userId, viewer.userId))
      : sql`false`
    : visibleChecks(viewer);
  return db
    .select()
    .from(credentialChecks)
    .where(where)
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
 * worker); the pre-flight leaves them alone.
 */
export async function saveCheck(
  ref: Pick<
    CredentialRef,
    "key" | "kind" | "label" | "scope" | "workspaceId" | "userId" | "teamId"
  >,
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
    teamId: ref.teamId,
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

/** Drops rows whose credential is gone (not seen by a pass that started at `passStart`). */
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

/** When the last pass checked anything (the page's "last checked" header). */
export async function lastCheckedAt(): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${credentialChecks.checkedAt})` })
    .from(credentialChecks);
  return row?.at ? new Date(row.at) : null;
}
