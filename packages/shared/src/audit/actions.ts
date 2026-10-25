/**
 * The audit trail's catalog (docs/audit.md): what the actions it records
 * mean, and the groups the Audit page filters by. The rows themselves are
 * the action log's (`optio_actions`); the API writes them through
 * `auditEvent` (apps/api/src/services/audit.ts) or upstream's `logAction`.
 *
 * An action is a dotted name, `<resource>.<verb>[.<detail>]`. A filter
 * names an action or a prefix of whole segments: `team` matches `team.create`
 * and `team.join.approve`, `team.join` matches `team.join.approve` but not
 * `team.joined` (`auditActionMatches`, and the same rule in SQL).
 */

/** Retention when neither the app nor OPTIO_AUDIT_RETENTION_DAYS says otherwise. */
export const AUDIT_RETENTION_DEFAULT_DAYS = 365;
/** The longest retention the app accepts (100 years). */
export const AUDIT_RETENTION_MAX_DAYS = 36_500;

/** What each action the audit trail records means, in the Audit page's words. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  // Sign-in
  "auth.sign_in": "Signed in",
  "auth.sign_in.failure": "Sign-in refused",
  "auth.sign_out": "Signed out",
  // Personal access tokens (API keys)
  "api_key.create": "API key created",
  "api_key.delete": "API key deleted",
  // Tokens stored as secrets for a person, a team or the organization
  "gateway.token.set": "Gateway token set",
  "gateway.token.delete": "Gateway token deleted",
  "gitlab.token.set": "GitLab token set",
  "gitlab.token.delete": "GitLab token deleted",
  "github.token.set": "GitHub token set",
  "github.token.delete": "GitHub token deleted",
  "agent.token.set": "Agent token set",
  "agent.token.delete": "Agent token deleted",
  // Gateway keys Optio makes on a model gateway, and budgets (docs/model-gateway.md)
  "gateway_key.issue": "Gateway key made",
  "gateway_key.rotate": "Gateway key rotated",
  "gateway_key.revoke": "Gateway key revoked",
  "team_key.create": "Team gateway key made",
  "budget.set": "Gateway budget set",
  "model_provider.key_issuing": "Gateway token settings changed",
  // Teams
  "team.create": "Team created",
  "team.update": "Team changed",
  "team.delete": "Team deleted",
  "team.groups": "Team's directory groups changed",
  "team.join": "Joined a team",
  "team.join.request": "Asked to join a team",
  "team.join.approve": "Join request approved",
  "team.join.deny": "Join request denied",
  "team.leave": "Left a team",
  "team.member.add": "Team member added",
  "team.member.role": "Team member's role changed",
  "team.member.remove": "Team member removed",
  "team.chat_channel.set": "Team's chat channel set",
  "team.chat_channel.delete": "Team's chat channel removed",
  // Workspaces
  "workspace.create": "Workspace created",
  "workspace.delete": "Workspace deleted",
  "workspace.settings": "Workspace settings changed",
  "workspace.default_gateway": "Default gateway changed",
  "workspace.member.add": "Workspace member added",
  "workspace.member.join": "Joined a workspace",
  "workspace.member.role": "Workspace member's role changed",
  "workspace.member.remove": "Workspace member removed",
  // Merging
  "pr.merge": "Merge request merged",
  "pr.merge.refused": "Agent merge refused",
  "auto_merge.confirm": "Automatic merging confirmed",
  "auto_merge.off": "Automatic merging turned off",
  // Settings
  "sign_in.provider_saved": "Sign-in settings saved",
  "sign_in.provider_deleted": "Sign-in settings removed",
  "sign_in.deployment_admin_added": "Deployment admin added",
  "sign_in.deployment_admin_removed": "Deployment admin removed",
  "sign_in.deployment_admin_claimed": "Deployment admin claimed with the setup token",
  "settings.update": "Optio settings changed",
  // Notifications (docs/notifications.md)
  "notify.chat_hook.set": "Own chat hook set",
  "notify.chat_hook.delete": "Own chat hook removed",
  "notify.outbox.retry": "Undelivered notifications retried",
  "notify.outbox.discard": "Undelivered notifications discarded",
  "audit.settings": "Audit retention changed",
  "audit.export": "Audit trail exported",
  // Integrations that hold a site's credentials
  "remote_workspace_connection.create": "Remote-workspace connection added",
  "remote_workspace_connection.update": "Remote-workspace connection changed",
  "remote_workspace_connection.delete": "Remote-workspace connection removed",
  // Entries written before remote workspaces had several providers.
  "coder_connection.create": "Remote-workspace connection added (Coder)",
  "coder_connection.update": "Remote-workspace connection changed (Coder)",
  "coder_connection.delete": "Remote-workspace connection removed (Coder)",
  "ticket_provider.create": "Ticket provider added",
  "ticket_provider.delete": "Ticket provider removed",
  "ticket_provider.enable": "Ticket provider re-enabled",
  "ticket_provider.round_trip": "Ticket provider's Jira round trip changed",
  // Secrets (any name; tokens above also write one of these)
  "secret.upsert": "Secret stored",
  "secret.delete": "Secret deleted",
  // Accounts and the directory sync (docs/directory-sync.md)
  "user.disabled": "Account disabled",
  "user.enabled": "Account enabled",
  "directory.sync": "Directory sync ran",
  "directory.settings": "Directory sync settings changed",
  // @-mentions of Optio's GitLab user (docs/gitlab-bot.md)
  "gitlab_mention.start": "Work started from a GitLab comment",
  "gitlab_mention.resume": "Work resumed from a GitLab comment",
  "gitlab_mention.refuse": "GitLab comment refused",
  "gitlab_bot.settings": "GitLab bot settings changed",
  // Agent policy: deny rules, RuntimeClass (docs/agent-policy.md)
  "agent_policy.update": "Agent policy changed",
  // Database restores (docs/backup.md)
  "database.restored": "Database restored from a dump",
};

/** One choice in the Audit page's Action filter: a label and the prefixes it matches. */
export interface AuditActionGroup {
  id: string;
  label: string;
  prefixes: readonly string[];
}

export const AUDIT_ACTION_GROUPS: readonly AuditActionGroup[] = [
  { id: "sign-in", label: "Sign-in and sign-out", prefixes: ["auth"] },
  { id: "api-keys", label: "API keys", prefixes: ["api_key"] },
  {
    id: "tokens",
    label: "Tokens",
    prefixes: [
      "gateway.token",
      "gitlab.token",
      "github.token",
      "agent.token",
      "gateway_key",
      "team_key",
      "budget",
    ],
  },
  { id: "teams", label: "Teams", prefixes: ["team"] },
  { id: "members", label: "Workspace members", prefixes: ["workspace.member"] },
  { id: "merges", label: "Merges", prefixes: ["pr.merge", "auto_merge"] },
  {
    id: "settings",
    label: "Settings",
    prefixes: [
      "sign_in",
      "settings",
      "audit.settings",
      "workspace.settings",
      "workspace.default_gateway",
      "workspace.create",
      "workspace.delete",
      "model_provider",
      "remote_workspace_connection",
      "coder_connection",
      "ticket_provider",
      "agent_policy",
      "notify",
    ],
  },
  { id: "secrets", label: "Secrets", prefixes: ["secret"] },
  { id: "accounts", label: "Accounts and directory sync", prefixes: ["user", "directory"] },
  { id: "gitlab-bot", label: "GitLab comments", prefixes: ["gitlab_mention", "gitlab_bot"] },
  { id: "database", label: "Database restores", prefixes: ["database"] },
];

/** The label for an action, or the action itself when the catalog has none. */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/**
 * Whether `action` matches `filter`: the same action, or one that starts with
 * the filter's whole segments (`team.join` matches `team.join.approve`).
 */
export function auditActionMatches(action: string, filter: string): boolean {
  const f = filter.trim().replace(/\.+$/, "");
  if (!f) return true;
  return action === f || action.startsWith(`${f}.`);
}
