/**
 * The checks the deployment's merge confirmation adds before Optio merges a
 * PR by itself (the reconciler's `autoMergePr`; docs/merge-confirmation.md).
 * They run only while the confirmation is on; with it off, auto-merge is
 * what it always was. The decision (`reconcile-repo.ts`) already wanted the
 * confirmed setting and no "changes requested"; reading the PR and every
 * review again right before the write is defence in depth, because the
 * snapshot is a few seconds old and a merge can't be undone. A merge a
 * person starts (the Merge button) never comes through here.
 *
 * Nothing here turns an API error into permission to merge: a failed read
 * throws, and the caller treats that as "don't merge".
 */
import type { PullRequest, Review, WorldSnapshot } from "@optio/shared";

/** Why the merge must not happen now, or null when it may. */
export type AutoMergeBlocker =
  "auto_merge_not_confirmed" | "pr_draft" | "pr_not_mergeable" | "pr_changes_requested";

/**
 * The setting itself: on, and confirmed by a person (the checkbox AND the
 * dialog, shared `work/auto-merge.ts`). Read from the snapshot the decision
 * was made on.
 */
export function autoMergeSettingBlocker(snapshot: WorldSnapshot): AutoMergeBlocker | null {
  const { autoMerge, autoMergeConfirmed, cautiousMode } = snapshot.settings;
  return autoMerge && autoMergeConfirmed === true && !cautiousMode
    ? null
    : "auto_merge_not_confirmed";
}

/**
 * Whether any reviewer's latest say on the PR is "changes requested" — a
 * later approval by someone else doesn't clear it, only that reviewer's own
 * approval (or the review being dismissed) does.
 */
export function hasChangesRequested(reviews: readonly Review[]): boolean {
  const latest = new Map<string, Review["state"]>();
  for (const r of reviews) {
    if (r.state === "COMMENTED") continue;
    latest.set(r.author, r.state);
  }
  return [...latest.values()].includes("CHANGES_REQUESTED");
}

/** The PR as the platform has it now, and its reviews. */
export function pullRequestBlocker(
  pr: Pick<PullRequest, "draft" | "mergeable">,
  reviews: readonly Review[],
): AutoMergeBlocker | null {
  if (pr.draft) return "pr_draft";
  if (pr.mergeable === false) return "pr_not_mergeable";
  if (hasChangesRequested(reviews)) return "pr_changes_requested";
  return null;
}

/** What `agentMergeBlocker` reads off a controller principal. */
export interface MergeCaller {
  run?: { sessionId?: string };
  sessionPolicy?: { confirmWrites: boolean };
}

/** The 403 an agent's own merge_pr answers while the merge confirmation is on. */
export const AGENT_MERGE_MESSAGE =
  "An agent can't merge by itself here: a person merges it (the Merge button), or turns on automatic merging and confirms it";

/**
 * While the merge confirmation is on, the controller's merge_pr is a
 * person's action: their own token (no run), or an agent in a session whose
 * writes wait for the person's approval card. A token an agent run holds (a
 * Task, a Job, a turn, a session that doesn't ask first) never merges on the
 * agent's say; the only merge Optio then makes by itself is the
 * reconciler's, behind the confirmed setting, CI and the reviews above.
 */
export function agentMergeBlocker(p: MergeCaller): string | null {
  if (!p.run) return null;
  if (p.run.sessionId && p.sessionPolicy?.confirmWrites === true) return null;
  return AGENT_MERGE_MESSAGE;
}
