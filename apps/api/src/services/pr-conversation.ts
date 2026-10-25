import type { GitPlatform, RepoIdentifier } from "@optio/shared";

/**
 * The newest items of each part a review's context carries: the counts a
 * PR's first page of reviews (30), comments (30) and inline comments (50)
 * gave on GitHub. The context reaches the agent's pod inside its start
 * script, one argument with a 128 KiB limit, so a platform that reads more
 * (GitHub's paged reviews, GitLab's 300 newest notes) is cut back here.
 */
export const CONVERSATION_LIMITS = { reviews: 30, comments: 30, inline: 50 } as const;

/** What a review agent reads of a PR's conversation, as Markdown (empty when none). */
export interface PrConversation {
  existingReviews: string;
  prComments: string;
  inlineComments: string;
}

/**
 * The PR / MR's reviews, general discussion and comments on lines of the
 * diff, for a review agent's context: the newest of each, up to
 * `CONVERSATION_LIMITS`. A read that fails leaves its part empty. GitLab
 * lists every MR note as a COMMENTED review too, so a COMMENTED review whose
 * text is already among the comments is not repeated under the reviews.
 */
export async function readPrConversation(
  platform: GitPlatform,
  ri: RepoIdentifier,
  prNumber: number,
): Promise<PrConversation> {
  const [reviews, comments, inline] = await Promise.all([
    platform.getReviews(ri, prNumber).catch(() => []),
    (platform.getPullRequestComments
      ? platform.getPullRequestComments(ri, prNumber)
      : platform.getIssueComments(ri, prNumber)
    ).catch(() => []),
    platform.getInlineComments(ri, prNumber).catch(() => []),
  ]);

  const asComments =
    platform.type === "gitlab" ? new Set([...comments, ...inline].map((c) => c.body)) : null;
  const shownReviews = reviews
    .filter((r) => r.body?.trim() && !(r.state === "COMMENTED" && asComments?.has(r.body)))
    .slice(-CONVERSATION_LIMITS.reviews);

  return {
    existingReviews: shownReviews
      .map((r) => `**${r.author}** (${r.state}):\n${r.body}`)
      .join("\n\n"),
    prComments: comments
      .slice(-CONVERSATION_LIMITS.comments)
      .map((c) => `**${c.author}** (${c.createdAt}):\n${c.body}`)
      .join("\n\n"),
    inlineComments: inline
      .slice(-CONVERSATION_LIMITS.inline)
      .map((c) => `**${c.author}** on \`${c.path}${c.line ? `:${c.line}` : ""}\`:\n${c.body}`)
      .join("\n\n"),
  };
}
