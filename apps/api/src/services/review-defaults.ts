/**
 * What a code review runs with, beyond its agent and model (review-config.ts):
 * the prompt, how deep it goes, the test command and its turn budget. Both
 * review entry points read it — review-service.ts (a review subtask on an MR
 * Optio opened) and pr-review-service.ts (a review of someone else's MR).
 *
 * The prompt: the repo's own `review_prompt_template` → the workspace's
 * saved one (Settings → Code review, the "review-default" prompt_templates
 * row) → the built-in default. A repo that leaves its template null follows
 * the workspace's and the built-in's changes, upgrades included.
 *
 * The depth: work that asks for its own review → the repo's `review_depth`
 * → the workspace's → "thorough" (`effectiveReviewDepth`). A light review
 * reads the diff only: no test command, half the turns.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import {
  DEFAULT_MAX_TURNS_REVIEW,
  effectiveReviewDepth,
  reviewDepthVars,
  reviewMaxTurns,
  type ReviewDepth,
  type WorkSettings,
} from "@optio/shared";
import { db } from "../db/client.js";
import { promptTemplates } from "../db/schema.js";

/** The prompt_templates row the Settings "Code review" card saves. */
export const REVIEW_DEFAULT_TEMPLATE_NAME = "review-default";

/**
 * The workspace's saved review prompt, else the instance's (a row with no
 * workspace), else null. Blank counts as none.
 */
export async function workspaceReviewTemplate(
  workspaceId: string | null | undefined,
): Promise<string | null> {
  const rows = await db
    .select({ template: promptTemplates.template, workspaceId: promptTemplates.workspaceId })
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.name, REVIEW_DEFAULT_TEMPLATE_NAME),
        isNull(promptTemplates.repoUrl),
        isNull(promptTemplates.ownerUserId),
        workspaceId
          ? or(eq(promptTemplates.workspaceId, workspaceId), isNull(promptTemplates.workspaceId))
          : isNull(promptTemplates.workspaceId),
      ),
    );
  const row =
    (workspaceId ? rows.find((r) => r.workspaceId === workspaceId) : undefined) ??
    rows.find((r) => r.workspaceId === null);
  return row?.template?.trim() ? row.template : null;
}

/** The review prompt: the repo's, else the workspace's, else `builtin`. */
export async function resolveReviewTemplate(
  repoTemplate: string | null | undefined,
  workspaceId: string | null | undefined,
  builtin: string,
): Promise<string> {
  if (repoTemplate?.trim()) return repoTemplate;
  const saved = await workspaceReviewTemplate(workspaceId).catch(() => null);
  return saved ?? builtin;
}

/** The repo fields a review plan reads (a RepoRecord or a raw repos row). */
export interface ReviewRepoLike {
  reviewEnabled?: boolean | null;
  reviewDepth?: string | null;
  testCommand?: string | null;
  maxTurnsReview?: number | null;
}

export interface ReviewRunPlan {
  depth: ReviewDepth;
  /** Empty for a light review, which runs no tests. */
  testCommand: string;
  /** The turn budget: the repo's (else the default), halved for a light review. */
  maxTurnsReview: number;
  /** REVIEW_DEPTH / REVIEW_LIGHT for the prompt. */
  vars: { REVIEW_DEPTH: string; REVIEW_LIGHT: string };
}

export function planReviewRun(input: {
  repo: ReviewRepoLike | null | undefined;
  workspace?: { reviewDepth?: string | null; reviewTestCommand?: string | null } | null;
  /** The settings of the work whose MR is reviewed (none for someone else's MR). */
  work?: WorkSettings | null;
}): ReviewRunPlan {
  const depth = effectiveReviewDepth(input.work, input.repo, input.workspace?.reviewDepth);
  const testCommand =
    depth === "light"
      ? ""
      : input.repo?.testCommand?.trim() || input.workspace?.reviewTestCommand?.trim() || "";
  return {
    depth,
    testCommand,
    maxTurnsReview: reviewMaxTurns(depth, input.repo?.maxTurnsReview ?? DEFAULT_MAX_TURNS_REVIEW),
    vars: reviewDepthVars(depth),
  };
}
