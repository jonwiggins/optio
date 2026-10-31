import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { userIdentities, users } from "../db/schema.js";
import { findAccountByIdentity } from "./session-service.js";

/**
 * Which Optio account a comment's author is, for a bot that works as them
 * (services/gitlab-bot/, docs/gitlab-bot.md):
 *
 *   1. The account that signs in with that same GitHub or GitLab user
 *      (`linked`: set only when the comment's host is the service sign-in
 *      uses, so the ids are the same authority's).
 *   2. Else the one account whose **verified** email is the email the
 *      platform shows publicly for the author (GitHub and GitLab show a
 *      public email only once its owner confirmed it) — unless that account
 *      already signs in with a different user of the same service.
 *
 * Never a username or a display name: anyone can pick those. No public
 * email, an email no account has verified, or two accounts sharing it: no
 * person.
 */
export type PersonLookup =
  | { found: true; userId: string; by: "identity" | "email" }
  | { found: false; reason: "none" | "ambiguous" };

/** Whether a service supplied an email rather than a redaction placeholder. */
export function usableEmail(v: string | null | undefined): v is string {
  return !!v && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v.trim());
}

export async function findPerson(identity: {
  /** Set only when the comment's host is the configured sign-in authority. */
  linked?: { provider: "github" | "gitlab"; externalId: string } | null;
  /** The author's public email on the platform, read only when step 1 finds nobody. */
  email?: () => Promise<string | null>;
}): Promise<PersonLookup> {
  const linked = identity.linked?.externalId ? identity.linked : null;
  if (linked) {
    const account = await findAccountByIdentity(linked.provider, linked.externalId);
    if (account) return { found: true, userId: account.id, by: "identity" };
  }
  const email = identity.email ? await identity.email() : null;
  if (!usableEmail(email)) return { found: false, reason: "none" };
  const matches = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.emailVerified, true),
        sql`lower(${users.email}) = ${email.trim().toLowerCase()}`,
      ),
    )
    .limit(2);
  if (matches.length === 0) return { found: false, reason: "none" };
  if (matches.length > 1) return { found: false, reason: "ambiguous" };
  const userId = matches[0].id;
  // An account that signs in with another user of this service isn't this one.
  if (linked) {
    const [other] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          or(
            eq(users.provider, linked.provider),
            sql`${users.id} IN (SELECT ${userIdentities.userId} FROM ${userIdentities} WHERE ${userIdentities.provider} = ${linked.provider})`,
          ),
        ),
      );
    if (other) return { found: false, reason: "none" };
  }
  return { found: true, userId, by: "email" };
}
