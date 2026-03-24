import { Worker, Queue } from "bullmq";
import {
  TaskState,
  TASK_BRANCH_PREFIX,
  renderPromptTemplate,
  renderTaskFile,
  TASK_FILE_PATH,
  DEFAULT_MAX_TURNS_CODING,
  DEFAULT_MAX_TURNS_REVIEW,
} from "@optio/shared";
import { getAdapter } from "@optio/agent-adapters";
import { parseClaudeEvent } from "../services/agent-event-parser.js";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import * as taskService from "../services/task-service.js";
import * as repoPool from "../services/repo-pool-service.js";
import { resolveSecretsForTask, retrieveSecret } from "../services/secret-service.js";
import { getPromptTemplate } from "../services/prompt-template-service.js";
import { logger } from "../logger.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const connectionOpts = { url: redisUrl, maxRetriesPerRequest: null };

export const taskQueue = new Queue("tasks", { connection: connectionOpts });

export function startTaskWorker() {
  const worker = new Worker(
    "tasks",
    async (job) => {
      const { taskId, resumeSessionId, resumePrompt, reviewOverride } = job.data as {
        taskId: string;
        resumeSessionId?: string;
        resumePrompt?: string;
        reviewOverride?: {
          renderedPrompt: string;
          taskFileContent: string;
          taskFilePath: string;
          claudeModel?: string;
        };
      };
      const log = logger.child({ taskId, jobId: job.id });
      let repoPodId: string | null = null;

      try {
        // Verify task is in queued state before proceeding
        // (BullMQ may retry stale jobs from a previous failed attempt)
        const currentTask = await taskService.getTask(taskId);
        if (!currentTask || currentTask.state !== "queued") {
          log.info({ state: currentTask?.state }, "Skipping — task is not in queued state");
          return;
        }

        // Check global concurrency limit
        const [{ count: activeCount }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(tasks)
          .where(sql`${tasks.state} IN ('provisioning', 'running')`);
        const globalMax = parseInt(process.env.OPTIO_MAX_CONCURRENT ?? "5", 10);
        if (Number(activeCount) >= globalMax) {
          log.info({ activeCount, globalMax }, "Global concurrency limit reached, re-queuing");
          // Re-add with a delay so it tries again later
          await taskQueue.add("process-task", job.data, {
            jobId: `${taskId}-delayed-${Date.now()}`,
            priority: currentTask.priority ?? 100,
            delay: 10000,
          });
          return;
        }

        // Check per-repo concurrency limit
        const { getRepoByUrl } = await import("../services/repo-service.js");
        const repoConfig = await getRepoByUrl(currentTask.repoUrl);
        if (repoConfig?.maxConcurrentTasks) {
          const [{ count: repoActiveCount }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(tasks)
            .where(
              sql`${tasks.repoUrl} = ${currentTask.repoUrl} AND ${tasks.state} IN ('provisioning', 'running')`,
            );
          if (Number(repoActiveCount) >= repoConfig.maxConcurrentTasks) {
            log.info(
              { repoActiveCount, max: repoConfig.maxConcurrentTasks },
              "Repo concurrency limit reached, re-queuing",
            );
            await taskQueue.add("process-task", job.data, {
              jobId: `${taskId}-delayed-${Date.now()}`,
              priority: currentTask.priority ?? 100,
              delay: 10000,
            });
            return;
          }
        }

        // Transition to provisioning
        await taskService.transitionTask(taskId, TaskState.PROVISIONING, "worker_pickup");
        log.info("Provisioning");

        // Get task details
        const task = await taskService.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        // Get agent adapter and build config
        const adapter = getAdapter(task.agentType);
        const claudeAuthMode =
          ((await retrieveSecret("CLAUDE_AUTH_MODE").catch(() => null)) as any) ?? "api-key";
        const optioApiUrl = `http://${process.env.API_HOST ?? "host.docker.internal"}:${process.env.API_PORT ?? "4000"}`;

        // Load and render prompt template
        const promptConfig = await getPromptTemplate(task.repoUrl);

        // repoConfig already loaded above for concurrency check

        const repoName = task.repoUrl.replace(/.*github\.com[/:]/, "").replace(/\.git$/, "");
        const branchName = `${TASK_BRANCH_PREFIX}${task.id}`;
        const taskFilePath = TASK_FILE_PATH;

        const renderedPrompt = renderPromptTemplate(promptConfig.template, {
          TASK_FILE: taskFilePath,
          BRANCH_NAME: branchName,
          TASK_ID: task.id,
          TASK_TITLE: task.title,
          REPO_NAME: repoName,
          AUTO_MERGE: String(promptConfig.autoMerge),
        });

        const taskFileContent = renderTaskFile({
          taskTitle: task.title,
          taskBody: task.prompt,
          taskId: task.id,
          ticketSource: task.ticketSource ?? undefined,
          ticketUrl: (task.metadata as any)?.ticketUrl,
        });

        // Apply review overrides if this is a review task
        const finalRenderedPrompt = reviewOverride?.renderedPrompt ?? renderedPrompt;
        const finalTaskFileContent = reviewOverride?.taskFileContent ?? taskFileContent;
        const finalTaskFilePath = reviewOverride?.taskFilePath ?? taskFilePath;
        const finalClaudeModel =
          reviewOverride?.claudeModel ?? repoConfig?.claudeModel ?? undefined;

        const agentConfig = adapter.buildContainerConfig({
          taskId: task.id,
          prompt: task.prompt,
          repoUrl: task.repoUrl,
          repoBranch: task.repoBranch,
          claudeAuthMode,
          optioApiUrl,
          renderedPrompt: finalRenderedPrompt,
          taskFileContent: finalTaskFileContent,
          taskFilePath: finalTaskFilePath,
          claudeModel: finalClaudeModel,
          claudeContextWindow: repoConfig?.claudeContextWindow ?? undefined,
          claudeThinking: repoConfig?.claudeThinking ?? undefined,
          claudeEffort: repoConfig?.claudeEffort ?? undefined,
        });

        // Encode setup files
        if (agentConfig.setupFiles && agentConfig.setupFiles.length > 0) {
          agentConfig.env.OPTIO_SETUP_FILES = Buffer.from(
            JSON.stringify(agentConfig.setupFiles),
          ).toString("base64");
        }

        // Resolve secrets (repo-scoped secrets override global ones)
        const resolvedSecrets = await resolveSecretsForTask(
          agentConfig.requiredSecrets,
          task.repoUrl,
        );
        const allEnv = { ...agentConfig.env, ...resolvedSecrets };

        // Inject repo-level setup config into pod env
        if (repoConfig?.extraPackages) {
          allEnv.OPTIO_EXTRA_PACKAGES = repoConfig.extraPackages;
        }
        if (repoConfig?.setupCommands) {
          allEnv.OPTIO_SETUP_COMMANDS = repoConfig.setupCommands;
        }

        // For max-subscription mode, fetch the OAuth token from the auth proxy
        if (claudeAuthMode === "max-subscription") {
          const { getClaudeAuthToken } = await import("../services/auth-service.js");
          const authResult = getClaudeAuthToken();
          if (authResult.available && authResult.token) {
            allEnv.CLAUDE_CODE_OAUTH_TOKEN = authResult.token;
            log.info("Injected CLAUDE_CODE_OAUTH_TOKEN from host credentials");
          } else {
            throw new Error(
              `Max subscription auth failed: ${authResult.error ?? "Token not available"}`,
            );
          }
        }

        // Get or create a repo pod for this repo
        log.info("Getting repo pod");
        const pod = await repoPool.getOrCreateRepoPod(task.repoUrl, task.repoBranch, allEnv);
        repoPodId = pod.id;
        log.info({ podName: pod.podName }, "Repo pod ready");

        await taskService.updateTaskContainer(taskId, pod.podName ?? pod.podId ?? pod.id);
        await taskService.transitionTask(taskId, TaskState.RUNNING, "worktree_created");
        log.info("Running agent in worktree");

        // Build the agent command based on type
        const isReviewTask = !!reviewOverride || task.taskType === "review";
        const agentCommand = buildAgentCommand(task.agentType, allEnv, {
          resumeSessionId,
          resumePrompt,
          isReview: isReviewTask,
          maxTurnsCoding: repoConfig?.maxTurnsCoding ?? undefined,
          maxTurnsReview: repoConfig?.maxTurnsReview ?? undefined,
        });

        // Execute the task in the repo pod via worktree
        const execSession = await repoPool.execTaskInRepoPod(pod, task.id, agentCommand, allEnv);

        // Stream stdout with structured parsing
        let allLogs = "";
        let sessionId: string | undefined;

        for await (const chunk of execSession.stdout as AsyncIterable<Buffer>) {
          const text = chunk.toString();
          allLogs += text;

          for (const line of text.split("\n")) {
            if (!line.trim()) continue;

            // Parse as Claude stream-json event (may produce multiple entries)
            const parsed = parseClaudeEvent(line, taskId);
            if (parsed.sessionId && !sessionId) {
              sessionId = parsed.sessionId;
              await taskService.updateTaskSession(taskId, sessionId);
              log.info({ sessionId }, "Session ID captured");
            }
            for (const entry of parsed.entries) {
              await taskService.appendTaskLog(
                taskId,
                entry.content,
                "stdout",
                entry.type,
                entry.metadata,
              );

              // Check for PR URL — only capture URLs likely from this task's own gh pr create.
              // Reject URLs embedded in JSON arrays (from gh pr list of other tasks).
              const prUrlPattern = /https:\/\/github\.com\/[^\s"]+\/pull\/\d+/g;
              const prMatches = entry.content.match(prUrlPattern);
              if (prMatches) {
                const taskBranch = `optio/task-${taskId}`;
                const content = entry.content.trim();
                const looksLikeJsonArray = content.startsWith("[") && content.includes('"number"');
                if (!looksLikeJsonArray) {
                  // Accept: standalone URL (gh pr create), text mentioning our branch,
                  // or any non-JSON context (agent narrative text)
                  const url = prMatches[prMatches.length - 1]; // last URL is usually the created one
                  await taskService.updateTaskPr(taskId, url);
                  log.info({ prUrl: url }, "PR URL detected in logs");
                } else if (entry.content.includes(taskBranch)) {
                  // JSON output but mentions our branch — safe to capture
                  const url = prMatches[prMatches.length - 1];
                  await taskService.updateTaskPr(taskId, url);
                  log.info({ prUrl: url }, "PR URL detected in logs (own branch in JSON)");
                }
              }
            }
          }
        }

        // Exec finished — determine result
        // Detect exit code from logs: check for is_error in result event, or fatal errors
        const hasResultError = allLogs.includes('"is_error":true');
        const hasFatalError =
          allLogs.includes("fatal:") ||
          allLogs.includes("Error: authentication_failed") ||
          allLogs.includes("exit 1");
        const inferredExitCode = hasResultError || hasFatalError ? 1 : 0;
        const result = adapter.parseResult(inferredExitCode, allLogs);
        await taskService.updateTaskResult(taskId, result.summary, result.error);

        if (result.costUsd != null) {
          await db
            .update(tasks)
            .set({ costUsd: String(result.costUsd) })
            .where(eq(tasks.id, taskId));
        }

        // Check if a PR URL was detected during streaming (may not be in final result)
        const taskAfterExec = await taskService.getTask(taskId);
        const detectedPrUrl = result.prUrl || taskAfterExec?.prUrl;

        if (detectedPrUrl && !isReviewTask) {
          // PR exists — go to pr_opened regardless of exit code.
          // The PR watcher will track CI status and handle merge/failure from here.
          if (result.prUrl) await taskService.updateTaskPr(taskId, result.prUrl);
          await taskService.transitionTask(
            taskId,
            TaskState.PR_OPENED,
            "pr_detected",
            detectedPrUrl,
          );
          log.info({ prUrl: detectedPrUrl }, "PR opened");
        } else if (result.success || isReviewTask) {
          await taskService.transitionTask(
            taskId,
            TaskState.COMPLETED,
            "agent_success",
            result.summary,
          );
          log.info("Task completed");
        } else {
          await taskService.transitionTask(taskId, TaskState.FAILED, "agent_failure", result.error);
          log.warn({ error: result.error }, "Task failed");
        }

        // If this is a subtask, check if parent should advance
        const completedTask = await taskService.getTask(taskId);
        if (completedTask?.parentTaskId) {
          const { onSubtaskComplete } = await import("../services/subtask-service.js");
          await onSubtaskComplete(taskId).catch((err) =>
            log.warn({ err }, "Failed to check parent subtask status"),
          );
        }
      } catch (err) {
        log.error({ err }, "Task worker error");
        try {
          await taskService.updateTaskResult(taskId, undefined, String(err));
          await taskService.transitionTask(taskId, TaskState.FAILED, "worker_error", String(err));
        } catch {
          // May fail if already terminal
        }
        throw err;
      } finally {
        // Release the task slot on the repo pod
        if (repoPodId) {
          await repoPool.releaseRepoPodTask(repoPodId).catch(() => {});
        }
      }
    },
    {
      connection: connectionOpts,
      concurrency: parseInt(process.env.OPTIO_MAX_CONCURRENT ?? "5", 10),
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Job failed");
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Job completed");
  });

  return worker;
}

/**
 * Re-enqueue orphaned tasks on startup.
 * After a Redis restart, BullMQ jobs are lost but tasks remain in
 * "queued" or "provisioning" state in the database. This function
 * detects those orphans and re-adds them to the queue.
 */
export async function reconcileOrphanedTasks() {
  const orphanedQueued = await db
    .select()
    .from(tasks)
    .where(eq(tasks.state, "queued" as any));

  const orphanedProvisioning = await db
    .select()
    .from(tasks)
    .where(eq(tasks.state, "provisioning" as any));

  const orphanedRunning = await db
    .select()
    .from(tasks)
    .where(eq(tasks.state, "running" as any));

  // Provisioning/running tasks lost their exec session — fail then re-queue
  for (const task of [...orphanedProvisioning, ...orphanedRunning]) {
    await taskService.transitionTask(
      task.id,
      TaskState.FAILED,
      "startup_reconcile",
      "Server restarted during execution",
    );
    await taskService.transitionTask(
      task.id,
      TaskState.QUEUED,
      "startup_reconcile",
      "Re-queued after server restart",
    );
  }

  // Re-query queued tasks (provisioning/running were just transitioned to queued above)
  const toEnqueue = await db
    .select()
    .from(tasks)
    .where(eq(tasks.state, "queued" as any));

  if (toEnqueue.length === 0) return;

  // Check existing BullMQ jobs to avoid duplicates
  const waiting = await taskQueue.getJobs(["waiting", "delayed", "active", "prioritized"]);
  const existingTaskIds = new Set(waiting.map((j) => j.data?.taskId).filter(Boolean));

  let enqueued = 0;
  for (const task of toEnqueue) {
    if (existingTaskIds.has(task.id)) continue;
    await taskQueue.add(
      "process-task",
      { taskId: task.id },
      {
        jobId: `${task.id}-reconcile-${Date.now()}`,
        priority: task.priority ?? 100,
      },
    );
    enqueued++;
  }

  if (enqueued > 0) {
    logger.info({ count: enqueued }, "Reconciled orphaned tasks after startup");
  }
}

function buildAgentCommand(
  agentType: string,
  env: Record<string, string>,
  opts?: {
    resumeSessionId?: string;
    resumePrompt?: string;
    isReview?: boolean;
    maxTurnsCoding?: number;
    maxTurnsReview?: number;
  },
): string[] {
  const prompt = opts?.resumePrompt ?? env.OPTIO_PROMPT;
  const maxTurns = opts?.isReview
    ? (opts.maxTurnsReview ?? DEFAULT_MAX_TURNS_REVIEW)
    : (opts?.maxTurnsCoding ?? DEFAULT_MAX_TURNS_CODING);

  switch (agentType) {
    case "claude-code": {
      const authSetup =
        env.OPTIO_AUTH_MODE === "max-subscription"
          ? [
              `if curl -sf "${env.OPTIO_API_URL}/api/auth/claude-token" > /dev/null 2>&1; then echo "[optio] Token proxy OK"; fi`,
              `unset ANTHROPIC_API_KEY 2>/dev/null || true`,
            ]
          : [];

      const resumeFlag = opts?.resumeSessionId
        ? `--resume ${JSON.stringify(opts.resumeSessionId)}`
        : "";

      return [
        ...authSetup,
        `echo "[optio] Running Claude Code${opts?.isReview ? " (review)" : ""}..."`,
        `claude -p ${JSON.stringify(prompt)} \\`,
        `  --dangerously-skip-permissions \\`,
        `  --output-format stream-json \\`,
        `  --verbose \\`,
        `  --max-turns ${maxTurns} \\`,
        `  ${resumeFlag}`.trim(),
      ];
    }
    case "codex":
      return [
        `echo "[optio] Running OpenAI Codex..."`,
        `codex exec --full-auto ${JSON.stringify(prompt)} --json`,
      ];
    default:
      return [`echo "Unknown agent type: ${agentType}" && exit 1`];
  }
}
