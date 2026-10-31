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
  /** About a piece of work (owner or creator) or about the person. */
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
  // workspaces of someone the directory sync or an admin disabled.
  {
    kind: "user.offboarded",
    label: "Someone left",
    description:
      "A person in a workspace you administer can no longer use Optio; their own automations were paused.",
    email: true,
    push: false,
    about: "person",
  },
  // Credential health (services/credential-health/alerts.ts): to the
  // token's owner, or the admins who manage the organization's.
  {
    kind: "token.expiring",
    label: "A token is about to expire",
    description:
      "A gateway or GitLab token you look after expires in 30, 7 or 1 days; work that uses it stops then.",
    email: true,
    push: false,
    about: "person",
  },
  {
    kind: "token.invalid",
    label: "A token stopped working",
    description: "A gateway or GitLab token you look after was refused: expired, revoked or wrong.",
    email: true,
    push: false,
    about: "person",
  },
  {
    kind: "budget.exceeded",
    label: "A gateway token is over budget",
    description:
      "A gateway token you look after spent its budget; the gateway refuses it until it resets.",
    email: true,
    push: false,
    about: "person",
  },
  {
    kind: "directory.sync_stopped",
    label: "Directory sync stopped",
    description: "A directory run is held or failed and needs a deployment administrator.",
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
