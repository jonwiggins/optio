/**
 * What Optio tells people about, and which channels each kind goes to by
 * default (docs/notifications.md). Settings → Notifications lists these in
 * this order; a person turns each channel on or off per kind
 * (preferences.ts).
 *
 * The work events share their keys with upstream's push preferences
 * (`notification-service.ts` `DEFAULT_PREFERENCES`), so "push" here is the
 * same switch the browser and the phone apps already use.
 *
 * Adding a kind (a budget warning, a token about to expire, an offboarding
 * notice): append it here, then call `notify({ kind, … })` (services/notify.ts).
 * A kind missing from this list is still delivered, by email, but nobody
 * can turn it off.
 */

export interface NotifyKind {
  kind: string;
  /** The row's title in Settings → Notifications. */
  label: string;
  description: string;
  /** Email unless the person turned it off. */
  email: boolean;
  /** Has an upstream push preference of the same key (browser / phone push). */
  push: boolean;
  /** About a piece of work (owner and team admins) or about the person. */
  about: "work" | "person";
}

export const NOTIFY_KINDS: readonly NotifyKind[] = [
  {
    kind: "task.pr_opened",
    label: "Merge request waiting for you",
    description: "Your work opened a merge request; it waits for you to review and merge it.",
    email: true,
    push: true,
    about: "work",
  },
  {
    kind: "task.needs_attention",
    label: "Needs attention",
    description: "Your work stopped and needs you: changes were asked for, or CI keeps failing.",
    email: true,
    push: true,
    about: "work",
  },
  {
    kind: "task.failed",
    label: "Failed",
    description: "Your work, or a run of your Job, failed.",
    email: true,
    push: true,
    about: "work",
  },
  {
    kind: "task.completed",
    label: "Merged",
    description: "Your work's merge request was merged.",
    email: false,
    push: true,
    about: "work",
  },
  // Offboarding (services/offboarding.ts) — to the admins of the
  // workspaces and teams of someone the directory sync or an admin disabled.
  {
    kind: "user.offboarded",
    label: "Someone left",
    description:
      "A person in a workspace or team you administer can no longer use Optio; their own automations were paused.",
    email: true,
    push: false,
    about: "person",
  },
  // Credential health (docs/credential-health.md): yours, your teams' (as
  // their admin), the organization's (as a deployment admin).
  {
    kind: "token.expiring",
    label: "Token expiring",
    description:
      "A GitLab, gateway or remote-workspace token you look after expires in 30, 7 or 1 days.",
    email: true,
    push: false,
    about: "person",
  },
  // Gateway keys made by Optio (services/gateway-key-check.ts): a person's
  // key, or a team's (its admins), at 80% and 100% of its gateway budget.
  // budget.exceeded is credential health's kind too, word for word: when
  // both are in, keep one entry (preferences.test.ts checks each kind is
  // listed once).
  {
    kind: "budget.warning",
    label: "Gateway budget almost spent",
    description: "A gateway key you look after has used 80% of its budget.",
    email: true,
    push: false,
    about: "person",
  },
  // To the deployment admins, when the directory sync starts holding or failing.
  {
    kind: "directory.sync_stopped",
    label: "Directory sync stopped",
    description:
      "The directory sync is changing nobody: the directory can't be read, or a run would disable too many people at once.",
    email: true,
    push: false,
    about: "person",
  },
  {
    kind: "token.invalid",
    label: "Token refused",
    description:
      "GitLab, the model gateway, Jira or a remote-workspace provider refused a token you look after: expired, revoked or wrong.",
    email: true,
    push: false,
    about: "person",
  },
  {
    kind: "budget.exceeded",
    label: "Gateway budget used up",
    description: "A gateway token you look after spent its budget; runs fail until it resets.",
    email: true,
    push: false,
    about: "person",
  },
];

/** The kind's entry, or null for a kind not listed here. */
export function kindInfo(kind: string): NotifyKind | null {
  return NOTIFY_KINDS.find((k) => k.kind === kind) ?? null;
}

/** Whether a kind is emailed when the person chose nothing: listed kinds say, others yes. */
export function emailByDefault(kind: string): boolean {
  return kindInfo(kind)?.email ?? true;
}
