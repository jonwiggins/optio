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
  // Workspaces
  "workspace.create": "Workspace created",
  "workspace.delete": "Workspace deleted",
  "workspace.settings": "Workspace settings changed",
  "workspace.member.add": "Workspace member added",
  "workspace.member.role": "Workspace member's role changed",
  "workspace.member.remove": "Workspace member removed",
  // Merging
  "pr.merge": "Merge request merged",
  "auto_merge.confirm": "Automatic merging confirmed",
  "auto_merge.off": "Automatic merging turned off",
  // Settings
  "sign_in.provider_saved": "Sign-in settings saved",
  "sign_in.provider_deleted": "Sign-in settings removed",
  "sign_in.deployment_admin_added": "Deployment admin added",
  "sign_in.deployment_admin_claimed": "Deployment admin claimed with the setup token",
  "settings.update": "Optio settings changed",
  "audit.settings": "Audit retention changed",
  "audit.export": "Audit trail exported",
  // Secrets (any name; tokens above also write one of these)
  "secret.upsert": "Secret stored",
  "secret.delete": "Secret deleted",
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
    prefixes: ["gateway.token", "gitlab.token", "github.token", "agent.token"],
  },
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
      "workspace.create",
      "workspace.delete",
      "model_provider",
    ],
  },
  { id: "secrets", label: "Secrets", prefixes: ["secret"] },
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
