/**
 * How deep a code review goes (docs/merge-confirmation.md "Review depth"),
 * beside its agent and model (review-config.ts). Both review entry points
 * read it: review-service.ts (a review subtask on a PR Optio opened) and
 * pr-review-service.ts (a review of someone else's PR).
 *
 * The depth: work that asks for its own review, then the repo's
 * `review_depth`, then the workspace's (Settings), then "thorough"
 * (`effectiveReviewDepth`). A thorough review is the review Optio has always
 * run: the same prompt, the repo's test command and turn budget. A light one
 * reads the diff only: no test command, half the turns, and a short note
 * after the prompt that says so (`LIGHT_REVIEW_NOTE`), whatever prompt the
 * repo uses.
 */
import {
  DEFAULT_MAX_TURNS_REVIEW,
  LIGHT_REVIEW_NOTE,
  effectiveReviewDepth,
  reviewMaxTurns,
  type ReviewDepth,
  type WorkSettings,
} from "@optio/shared";

/** The repo fields a review plan reads (a RepoRecord or a raw repos row). */
export interface ReviewRepoLike {
  reviewEnabled?: boolean | null;
  reviewDepth?: string | null;
  testCommand?: string | null;
  maxTurnsReview?: number | null;
}

export interface ReviewRunPlan {
  depth: ReviewDepth;
  /** The repo's test command; empty for a light review, which runs no tests. */
  testCommand: string;
  /**
   * The turn budget a light review gets (half the repo's, else half the
   * default); undefined for a thorough one, which keeps the worker's own.
   */
  maxTurnsReview: number | undefined;
  /** `REVIEW_DEPTH` for a prompt that wants to branch on it. */
  vars: { REVIEW_DEPTH: ReviewDepth };
}

export function planReviewRun(input: {
  repo: ReviewRepoLike | null | undefined;
  workspace?: { reviewDepth?: string | null } | null;
  /** The settings of the work whose PR is reviewed (none for someone else's PR). */
  work?: WorkSettings | null;
}): ReviewRunPlan {
  const depth = effectiveReviewDepth(input.work, input.repo, input.workspace?.reviewDepth);
  const light = depth === "light";
  return {
    depth,
    testCommand: light ? "" : (input.repo?.testCommand ?? ""),
    maxTurnsReview: light
      ? reviewMaxTurns(depth, input.repo?.maxTurnsReview ?? DEFAULT_MAX_TURNS_REVIEW)
      : undefined,
    vars: { REVIEW_DEPTH: depth },
  };
}

/** The rendered review prompt for `plan`: unchanged when thorough, the light note added otherwise. */
export function withReviewDepth(renderedPrompt: string, plan: ReviewRunPlan): string {
  return plan.depth === "light" ? renderedPrompt + LIGHT_REVIEW_NOTE : renderedPrompt;
}
