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
  // The directory sync (services/directory-sync.ts): what started a run and
  // what it found (counts; "enabled" is already on the upstream list).
  "trigger",
  "checked",
  "changed",
  "disabled",
  "errors",
  // Gateway keys Optio makes, and budgets (services/gateway-keys.ts): the
  // key's alias (never the key), its budget in USD and its period.
  "keyAlias",
  "maxBudget",
  "budgetDuration",
  // @-mentions on GitHub and GitLab (services/gitlab-bot/): the comment's
  // link and which of the two.
  "commentUrl",
  "platform",
  // Agent policy (services/agent-policy.ts): which level, the deny rules
  // added and removed (permission patterns, never values), the switches.
  "level",
  "added",
  "removed",
  "defaults",
  "runtimeClassName",
  // Database restores (services/database-restore-check.ts): the dump's file
  // name and the database the old one is kept as.
  "dump",
  "keptAs",
];
