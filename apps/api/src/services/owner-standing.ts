/**
 * A disabled account's own work doesn't run again (docs/directory-sync.md,
 * "Such a person is disabled": nothing new starts for them).
 *
 * Offboarding (services/offboarding.ts) pauses a leaver's automations and
 * revokes their sign-ins, but their waiting work — a merge request open, a
 * question asked — can still be resumed from outside: a comment on its Jira
 * ticket (ticket-follow-ups.ts), a review asking for changes, an @-mention on
 * its merge request. The task worker asks here before it provisions; work of a
 * disabled person fails at once, with a message that says why and what to do.
 *
 * A team's work stays the team's and runs (its creator is in `ownerUserId`
 * too, so `ownerTeamId` decides); organization work has no owner.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { ModelProviderError } from "./model-provider-service.js";

/**
 * The run is refused: its owner's account is disabled. A ModelProviderError,
 * so the task worker fails the run now rather than retrying it (the owner's
 * gateway keys and sign-ins are gone; a retry won't change that).
 */
export class DisabledOwnerError extends ModelProviderError {
  constructor(email: string) {
    super(
      `This is the personal work of ${email}, whose Optio account is disabled, so it doesn't run again. ` +
        "To go on with it, start it again as yourself or as a team's work.",
      403,
    );
    this.name = "DisabledOwnerError";
  }
}

/** Personal work whose owner is disabled: their email; anything else: null. */
export async function disabledOwnerOf(work: {
  ownerUserId: string | null;
  ownerTeamId: string | null;
}): Promise<string | null> {
  if (!work.ownerUserId || work.ownerTeamId) return null;
  const [owner] = await db
    .select({ email: users.email, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, work.ownerUserId));
  return owner?.disabledAt ? owner.email : null;
}

/** Throws DisabledOwnerError when `work` is the personal work of a disabled account. */
export async function assertOwnerActive(work: {
  ownerUserId: string | null;
  ownerTeamId: string | null;
}): Promise<void> {
  const email = await disabledOwnerOf(work);
  if (email) throw new DisabledOwnerError(email);
}
