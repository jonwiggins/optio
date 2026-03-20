import { Worker, Queue } from "bullmq";
import {
  TaskState,
  TASK_BRANCH_PREFIX,
  renderPromptTemplate,
  renderTaskFile,
  TASK_FILE_PATH,
} from "@optio/shared";
import { getAdapter } from "@optio/agent-adapters";
import { parseClaudeEvent } from "../services/agent-event-parser.js";
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
      const { taskId, resumeSessionId, resumePrompt } = job.data as {
        taskId: string;
        resumeSessionId?: string;
        resumePrompt?: string;
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

        const agentConfig = adapter.buildContainerConfig({
          taskId: task.id,
          prompt: task.prompt,
          repoUrl: task.repoUrl,
          repoBranch: task.repoBranch,
          claudeAuthMode,
          optioApiUrl,
          renderedPrompt,
          taskFileContent,
          taskFilePath,
        });

        // Encode setup files
        if (agentConfig.setupFiles && agentConfig.setupFiles.length > 0) {
          agentConfig.env.OPTIO_SETUP_FILES = Buffer.from(
            JSON.stringify(agentConfig.setupFiles),
          ).toString("base64");
        }

        // Resolve secrets
        const resolvedSecrets = await resolveSecretsForTask(agentConfig.requiredSecrets);
        const allEnv = { ...agentConfig.env, ...resolvedSecrets };

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
        const agentCommand = buildAgentCommand(task.agentType, allEnv, {
          resumeSessionId,
          resumePrompt,
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

            // Try to parse as Claude stream-json event
            const parsed = parseClaudeEvent(line, taskId);
            if (parsed.sessionId && !sessionId) {
              sessionId = parsed.sessionId;
              await taskService.updateTaskSession(taskId, sessionId);
              log.info({ sessionId }, "Session ID captured");
            }
            if (parsed.entry) {
              await taskService.appendTaskLog(
                taskId,
                parsed.entry.content,
                "stdout",
                parsed.entry.type,
                parsed.entry.metadata,
              );

              // Check for PR URL in text entries
              if (parsed.entry.type === "text" || parsed.entry.type === "info") {
                const prMatch = parsed.entry.content.match(
                  /https:\/\/github\.com\/[^\s]+\/pull\/\d+/,
                );
                if (prMatch) {
                  await taskService.updateTaskPr(taskId, prMatch[0]);
                }
              }
            }
          }
        }

        // Exec finished — determine result
        const result = adapter.parseResult(0, allLogs);
        await taskService.updateTaskResult(taskId, result.summary, result.error);

        if (result.prUrl) {
          await taskService.updateTaskPr(taskId, result.prUrl);
          await taskService.transitionTask(
            taskId,
            TaskState.PR_OPENED,
            "pr_detected",
            result.prUrl,
          );
          log.info({ prUrl: result.prUrl }, "PR opened");
        } else if (result.success) {
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

function buildAgentCommand(
  agentType: string,
  env: Record<string, string>,
  opts?: { resumeSessionId?: string; resumePrompt?: string },
): string[] {
  const prompt = opts?.resumePrompt ?? env.OPTIO_PROMPT;

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
        `echo "[optio] Running Claude Code..."`,
        `claude -p ${JSON.stringify(prompt)} \\`,
        `  --dangerously-skip-permissions \\`,
        `  --output-format stream-json \\`,
        `  --verbose \\`,
        `  --max-turns 50 \\`,
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
