import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, repos } from "../db/schema.js";
import {
  TaskState,
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  REVIEW_TASK_FILE_PATH,
  renderPromptTemplate,
  renderTaskFile,
} from "@optio/shared";
import { getAdapter } from "@optio/agent-adapters";
import * as taskService from "./task-service.js";
import * as repoPool from "./repo-pool-service.js";
import { resolveSecretsForTask, retrieveSecret } from "./secret-service.js";
import { getClaudeAuthToken } from "./auth-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { logger } from "../logger.js";

/**
 * Launch a review agent for a task that has an open PR.
 */
export async function launchReview(parentTaskId: string): Promise<string> {
  const parentTask = await taskService.getTask(parentTaskId);
  if (!parentTask) throw new Error("Parent task not found");
  if (!parentTask.prUrl) throw new Error("Parent task has no PR");

  // Parse PR number
  const prMatch = parentTask.prUrl.match(/\/pull\/(\d+)/);
  if (!prMatch) throw new Error("Cannot parse PR number from URL");
  const prNumber = parseInt(prMatch[1], 10);

  // Get repo config
  const [repoConfig] = await db.select().from(repos).where(eq(repos.repoUrl, parentTask.repoUrl));

  // Create the review task
  const reviewTask = await taskService.createTask({
    title: `Review: ${parentTask.title}`,
    prompt: `Review PR #${prNumber} for: ${parentTask.title}`,
    repoUrl: parentTask.repoUrl,
    agentType: "claude-code",
  });

  // Set the task type and parent link
  await db
    .update(tasks)
    .set({
      parentTaskId: parentTask.id,
      taskType: "review",
    })
    .where(eq(tasks.id, reviewTask.id));

  // Build the review prompt
  const reviewTemplate = repoConfig?.reviewPromptTemplate ?? DEFAULT_REVIEW_PROMPT_TEMPLATE;
  const repoName = parentTask.repoUrl.replace(/.*github\.com[/:]/, "").replace(/\.git$/, "");

  const renderedPrompt = renderPromptTemplate(reviewTemplate, {
    PR_NUMBER: String(prNumber),
    TASK_FILE: REVIEW_TASK_FILE_PATH,
    REPO_NAME: repoName,
    TASK_TITLE: parentTask.title,
    TEST_COMMAND: repoConfig?.testCommand ?? "",
  });

  // Build review context file
  const reviewContext = [
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
  ].join("\n");

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
        // Use review model if configured
        claudeModel: repoConfig?.reviewModel ?? "sonnet",
      },
    },
    {
      jobId: `${reviewTask.id}`,
      priority: 10, // Reviews are high priority
    },
  );

  logger.info({ parentTaskId, reviewTaskId: reviewTask.id, prNumber }, "Review agent launched");
  return reviewTask.id;
}
