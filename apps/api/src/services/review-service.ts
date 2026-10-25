import {
  TaskState,
  REVIEW_TASK_FILE_PATH,
  builtinPromptTemplates,
  renderPromptTemplate,
  parsePrUrl,
  parseRepoUrl,
  resolveRepoPlatform,
} from "@optio/shared";
import * as taskService from "./task-service.js";
import { getGitPlatformForRepo } from "./git-token-service.js";
import { readPrConversation } from "./pr-conversation.js";
import { taskQueue } from "../workers/task-worker.js";
import { logger } from "../logger.js";
import { resolveReviewConfig } from "./review-config.js";
import * as optioSettingsService from "./optio-settings-service.js";
import { planReviewRun, resolveReviewTemplate, type ReviewRepoLike } from "./review-defaults.js";

/**
 * Fetch PR description, reviews, and comments to give the
 * review agent richer context about the PR being reviewed.
 */
async function fetchPrContext(
  repoUrl: string,
  prNumber: number,
  createdBy: string | null,
  /** The parent task's workspace and team, for the GitLab token (git-token-service.ts). */
  owner?: { workspaceId?: string | null; ownerTeamId?: string | null },
): Promise<{
  prDescription: string;
  existingReviews: string;
  prComments: string;
  inlineComments: string;
}> {
  const result = { prDescription: "", existingReviews: "", prComments: "", inlineComments: "" };
  try {
    const { platform, ri } = await getGitPlatformForRepo(repoUrl, {
      userId: createdBy ?? undefined,
      workspaceId: owner?.workspaceId,
      ownerTeamId: owner?.ownerTeamId,
      server: !createdBy,
    });

    // Fetch PR description
    try {
      const prData = await platform.getPullRequest(ri, prNumber);
      result.prDescription = prData.body;
    } catch {}

    // Reviews, the PR's general discussion and its inline comments
    Object.assign(result, await readPrConversation(platform, ri, prNumber));
  } catch (err) {
    logger.warn({ err, repoUrl, prNumber }, "Failed to fetch PR context for review");
  }
  return result;
}

/**
 * Launch a review agent for a task that has an open PR.
 */
export async function launchReview(parentTaskId: string): Promise<string> {
  const parentTask = await taskService.getTask(parentTaskId);
  if (!parentTask) throw new Error("Parent task not found");
  if (!parentTask.prUrl) throw new Error("Parent task has no PR");

  // Parse PR number from URL (works for both GitHub and GitLab)
  const parsed = parsePrUrl(parentTask.prUrl);
  if (!parsed) throw new Error("Cannot parse PR number from URL");
  const { owner, repo, prNumber } = parsed;

  // Get repo config
  const { getRepoByUrl } = await import("./repo-service.js");
  const repoConfig = await getRepoByUrl(parentTask.repoUrl);

  // Resolve which agent + model the review should run with. The same resolver
  // is used by pr-review-worker so config behaviour stays consistent across
  // the two review entrypoints.
  const globalSettings = await optioSettingsService
    .getSettings(parentTask.workspaceId ?? null)
    .catch(() => null);
  const review = resolveReviewConfig({
    repoReviewAgentType: repoConfig?.reviewAgentType ?? null,
    repoDefaultAgentType: repoConfig?.defaultAgentType ?? null,
    repoReviewModel: repoConfig?.reviewModel ?? null,
    globalDefaultReviewAgentType: globalSettings?.defaultReviewAgentType ?? null,
    globalDefaultReviewModel: globalSettings?.defaultReviewModel ?? null,
  });

  // How deep the review goes (the work's own ask, the repo's, the
  // workspace's), its test command and turn budget (review-defaults.ts).
  const plan = planReviewRun({
    repo: repoConfig as ReviewRepoLike | null,
    workspace: globalSettings,
    work: parentTask.settings ?? null,
  });

  // Fetch PR context using platform abstraction
  const prContextPromise = fetchPrContext(
    parentTask.repoUrl,
    prNumber,
    parentTask.createdBy,
    parentTask,
  );

  // Create the review task as a subtask
  const { createSubtask } = await import("./subtask-service.js");

  const subtask = await createSubtask({
    parentTaskId,
    title: `Review: ${parentTask.title}`,
    prompt: `Review PR #${prNumber} for: ${parentTask.title}`,
    taskType: "review",
    blocksParent: true,
    agentType: review.agentType,
  });

  const reviewTask = subtask;

  // Build the review prompt
  // The repo's prompt, else the workspace's (Settings → Code review), else the built-in.
  const repoPlatform = resolveRepoPlatform(parentTask.repoUrl, repoConfig?.gitPlatform);
  const reviewTemplate = await resolveReviewTemplate(
    repoConfig?.reviewPromptTemplate,
    parentTask.workspaceId ?? null,
    builtinPromptTemplates(repoPlatform).review,
  );
  const repoName = `${owner}/${repo}`;

  const parsedRepo = parseRepoUrl(parentTask.repoUrl, repoPlatform ?? undefined);
  const isGitLab = parsedRepo?.platform === "gitlab";
  const isCodeCommit = parsedRepo?.platform === "codecommit";

  const renderedPrompt = renderPromptTemplate(reviewTemplate, {
    PR_NUMBER: String(prNumber),
    TASK_FILE: REVIEW_TASK_FILE_PATH,
    REPO_NAME: repoName,
    TASK_TITLE: parentTask.title,
    TEST_COMMAND: plan.testCommand,
    ...plan.vars,
    GIT_PLATFORM_GITLAB: isGitLab ? "true" : "",
    GIT_PLATFORM_CODECOMMIT: isCodeCommit ? "true" : "",
    CODECOMMIT_REPO: isCodeCommit ? (parsedRepo?.repo ?? "") : "",
    BASE_BRANCH: parentTask.repoBranch ?? repoConfig?.defaultBranch ?? "main",
  });

  // Build review context file with enriched PR data
  const prContext = await prContextPromise;

  const reviewContextParts = [
    `# Review Context`,
    ``,
    `## Original Task`,
    `**${parentTask.title}**`,
    ``,
    parentTask.prompt,
    ``,
    `## PR`,
    `- URL: ${parentTask.prUrl}`,
    `- Number: #${prNumber}`,
    `- Branch: optio/task-${parentTask.id}`,
  ];

  if (prContext.prDescription) {
    reviewContextParts.push(``, `## PR Description`, ``, prContext.prDescription);
  }

  if (prContext.existingReviews) {
    reviewContextParts.push(``, `## Existing Reviews`, ``, prContext.existingReviews);
  }

  if (prContext.prComments) {
    reviewContextParts.push(``, `## PR Discussion`, ``, prContext.prComments);
  }

  if (prContext.inlineComments) {
    reviewContextParts.push(``, `## Inline Code Comments`, ``, prContext.inlineComments);
  }

  const reviewContext = reviewContextParts.join("\n");

  // Queue the review task
  await taskService.transitionTask(reviewTask.id, TaskState.QUEUED, "review_requested");
  await taskQueue.add(
    "process-task",
    {
      taskId: reviewTask.id,
      // Override the prompt and task file for the review
      reviewOverride: {
        renderedPrompt,
        taskFileContent: reviewContext,
        taskFilePath: REVIEW_TASK_FILE_PATH,
        // Agent-agnostic model field — read by the worker for any review agent.
        model: review.model,
        // Back-compat: keep populating claudeModel for one release so
        // in-flight workers that pre-date the resolver still find a model.
        claudeModel: review.model,
        // A light review has half the turns (review-defaults.ts).
        reviewDepth: plan.depth,
        maxTurnsReview: plan.maxTurnsReview,
      },
    },
    {
      jobId: `${reviewTask.id}`,
      priority: 10, // Reviews are high priority
    },
  );

  logger.info(
    { parentTaskId, reviewTaskId: reviewTask.id, prNumber, depth: plan.depth },
    "Review agent launched",
  );
  return reviewTask.id;
}
