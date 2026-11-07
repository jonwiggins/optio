/**
 * The audit trail's own `params` keys (docs/audit.md), added to the action
 * log's allowlist (`ACTION_PARAM_ALLOWLIST` in optio-action-service.ts).
 * Like the rest of that list, each is a label, an id or a small scalar —
 * never a secret value, a token, a prompt or a request body.
 *
 * A separate file so optio-action-service.ts (upstream) imports one list
 * and audit.ts can import logAction without a cycle.
 */
export const AUDIT_PARAM_KEYS: readonly string[] = [
  // Sign-in: which provider, by which door (web / cli), why it was refused,
  // and the name or address someone tried to sign in with.
  "provider",
  "via",
  "reason",
  "username",
  "email",
  // Membership: whose membership changed, in which team, to what.
  "targetUserId",
  "teamId",
  "role",
  "decision",
  // Settings: which fields a save changed (names, never values).
  "fields",
  "retentionDays",
  // Merges: the merge request, how, and the confirmation an automatic merge relied on.
  "prNumber",
  "mergeMethod",
  "confirmedBy",
  "confirmedAt",
  // API keys.
  "expiresAt",
];
