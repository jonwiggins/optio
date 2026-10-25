import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

/**
 * Which Optio person someone on another of the deployment's services is — the
 * author of a GitHub or GitLab comment (services/gitlab-bot/), say — by
 * what both know them by:
 *
 *   0. their **linked account**: the Optio account that signs in through
 *      that service (`users.provider` = `github` / `gitlab`, `external_id`
 *      = the service's user id), when the comment comes from the same
 *      GitHub or GitLab that sign-in uses. It decides when it matches;
 *      otherwise the steps below run;
 *   1. their **email**, when the service gave one: then only the email
 *      counts. An email that no account has is no answer, even when an
 *      account has their username — a GitLab local account named like a
 *      directory user (`carol`, registered with another address) must not
 *      become that user;
 *   2. only when the service gave no email: their **directory username** —
 *      the `username` sign-in keeps (an LDAP login name, OIDC
 *      `preferred_username`), which a GitLab signed in through the same
 *      directory shares. That assumes both use one directory
 *      (docs/gitlab-bot.md "Who Optio works as").
 *
 * This is stricter than sign-in, which links a first sign-in to an account
 * only by the provider's id or a verified email (session-service.ts
 * `createSession`) and never by username.
 *
 * Two accounts for the same email or username is no answer ("ambiguous"):
 * Optio never guesses whose credentials work runs with. A disabled account
 * (services/offboarding.ts) is found, so the caller can say why it won't act.
 */

export type PersonLookup =
  | { found: true; userId: string; by: "identity" | "email" | "username"; disabled: boolean }
  | { found: false; reason: "none" | "ambiguous"; by?: "email" | "username" };

/** Whether `v` reads as an email address (GitLab redacts it as `[REDACTED]`). */
export function usableEmail(v: string | null | undefined): v is string {
  return !!v && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v.trim());
}

async function byColumn(
  column: typeof users.email | typeof users.username,
  value: string,
): Promise<Array<{ id: string; disabledAt: Date | null }>> {
  return db
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(sql`lower(${column}) = ${value.trim().toLowerCase()}`)
    .limit(2);
}

export async function findPerson(identity: {
  email?: string | null;
  username?: string | null;
  /** The service's own id for them, and the sign-in provider that carries it. */
  linked?: { provider: "github" | "gitlab"; externalId: string } | null;
}): Promise<PersonLookup> {
  if (identity.linked?.externalId) {
    const rows = await db
      .select({ id: users.id, disabledAt: users.disabledAt })
      .from(users)
      .where(
        and(
          eq(users.provider, identity.linked.provider),
          eq(users.externalId, identity.linked.externalId),
        ),
      )
      .limit(2);
    if (rows.length === 1) {
      return { found: true, userId: rows[0].id, by: "identity", disabled: !!rows[0].disabledAt };
    }
  }
  if (usableEmail(identity.email)) {
    const rows = await byColumn(users.email, identity.email);
    if (rows.length === 1) {
      return { found: true, userId: rows[0].id, by: "email", disabled: !!rows[0].disabledAt };
    }
    if (rows.length > 1) return { found: false, reason: "ambiguous", by: "email" };
    // A known email decides: never fall back to a username another account has.
    return { found: false, reason: "none", by: "email" };
  }
  const username = identity.username?.trim();
  if (username) {
    const rows = await byColumn(users.username, username);
    if (rows.length === 1) {
      return { found: true, userId: rows[0].id, by: "username", disabled: !!rows[0].disabledAt };
    }
    if (rows.length > 1) {
      // Two accounts share the name: the only enabled one is the person (the
      // other one was left behind); two enabled ones are no answer.
      const enabled = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(sql`lower(${users.username}) = ${username.toLowerCase()}`, isNull(users.disabledAt)),
        )
        .limit(2);
      if (enabled.length === 1) {
        return { found: true, userId: enabled[0].id, by: "username", disabled: false };
      }
      return { found: false, reason: "ambiguous", by: "username" };
    }
  }
  return { found: false, reason: "none", by: username ? "username" : undefined };
}
