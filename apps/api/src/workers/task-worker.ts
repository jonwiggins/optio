import { Worker, Queue } from "bullmq";
import {
  TaskState,
  TASK_BRANCH_PREFIX,
  renderPromptTemplate,
  renderTaskFile,
  TASK_FILE_PATH,
  DEFAULT_MAX_TURNS_CODING,
  DEFAULT_MAX_TURNS_REVIEW,
  type PresetImageId,
  msUntilOffPeak,
  classifyError,
  parseRepoUrl,
  parsePrUrl,
} from "@optio/shared";
import { getAdapter } from "@optio/agent-adapters";
import { parseClaudeEvent } from "../services/agent-event-parser.js";
import { parseCodexEvent } from "../services/codex-event-parser.js";
import { parseCopilotEvent } from "../services/copilot-event-parser.js";
import { parseOpenCodeEvent } from "../services/opencode-event-parser.js";
import { parseGeminiEvent } from "../services/gemini-event-parser.js";
import { parseOpenClawEvent } from "../services/openclaw-event-parser.js";
import { checkExistingPr, type ExistingPr } from "../services/pr-detection-service.js";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import * as taskService from "../services/task-service.js";
import * as repoPool from "../services/repo-pool-service.js";
import { publishEvent } from "../services/event-bus.js";
import { resolveSecretsForTask, retrieveSecretWithFallback } from "../services/secret-service.js";
import { getPromptTemplate } from "../services/prompt-template-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";
import { getCredentialSecret } from "../services/credential-secret-service.js";
import { subscribeToTaskMessages } from "../services/task-message-bus.js";
import * as messageService from "../services/task-message-service.js";
import { logger } from "../logger.js";
import {
  recordTaskComplete,
  recordTaskDuration,
  recordTaskCost,
  recordTaskTokens,
} from "../telemetry/metrics.js";
import { emitCostReportLog } from "../telemetry/logs.js";
import { withSpan, injectTraceContextIntoJob } from "../telemetry/spans.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

import { getBullMQConnectionOptions } from "../services/redis-config.js";

const connectionOpts = getBullMQConnectionOptions();

export const taskQueue = new Queue("tasks", { connection: connectionOpts });

/**
 * Serialized claim lock.
 * Prevents concurrent BullMQ workers from all passing the concurrency
 * pre-check simultaneously (seeing 0 running), all claiming their tasks,
 * and then all failing the post-check — which creates a storm of
 * provisioning→queued state events that repeats every 10s.
 *
 * With the lock, only one worker at a time checks counts + claims,
 * so the counts are always accurate.
 */
let claimLockChain: Promise<void> = Promise.resolve();

function withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
  let releaseLock!: () => void;
  const nextLink = new Promise<void>((r) => (releaseLock = r));
  const prev = claimLockChain;
  claimLockChain = nextLink;
  return prev.then(fn).finally(releaseLock);
}

export function startTaskWorker() {
  const worker = new Worker(
    "tasks",
    instrumentWorkerProcessor("task-worker", async (job) => {
      const {
        taskId,
        resumeSessionId,
        resumePrompt,
        restartFromBranch,
        reviewOverride,
        provisioningRetryCount = 0,
      } = job.data as {
        taskId: string;
        resumeSessionId?: string;
        resumePrompt?: string;
        restartFromBranch?: boolean;
        provisioningRetryCount?: number;
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

        // ── Dependency check ──────────────────────────────────────────
        // If this task has unsatisfied dependencies, re-queue with a delay.
        const { areDependenciesMet, getDependencies: getTaskDeps } =
          await import("../services/dependency-service.js");
        const deps = await getTaskDeps(taskId);
        if (deps.length > 0) {
          const anyFailed = deps.some(
            (d) => d.state === TaskState.FAILED || d.state === TaskState.CANCELLED,
          );
          if (anyFailed) {
            log.info("Dependency failed — failing task");
            await taskService.transitionTask(
              taskId,
              TaskState.FAILED,
              "dependency_failed",
              "A dependency task has failed",
            );
            return;
          }
          const met = await areDependenciesMet(taskId);
          if (!met) {
            log.info("Dependencies not yet met, re-scheduling");
            const jitter = Math.floor(Math.random() * 5000);
            await taskQueue.add("process-task", job.data, {
              jobId: `${taskId}-depwait-${Date.now()}`,
              priority: currentTask.priority ?? 100,
              delay: 15000 + jitter,
            });
            return;
          }
        }

        // ── Off-peak hold check ────────────────────────────────────
        // If the repo has offPeakOnly enabled and we're in peak hours,
        // re-queue the task with a delay until off-peak starts.
        const { getRepoByUrl } = await import("../services/repo-service.js");
        const taskWorkspaceId = currentTask.workspaceId ?? null;
        const repoConfig = await getRepoByUrl(currentTask.repoUrl, taskWorkspaceId);

        if (repoConfig?.offPeakOnly && !currentTask.ignoreOffPeak) {
          const delayMs = msUntilOffPeak();
          if (delayMs > 0) {
            log.info({ delayMs }, "Off-peak only — holding task until off-peak window");
            await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
            await taskQueue.add("process-task", job.data, {
              jobId: `${taskId}-offpeak-${Date.now()}`,
              priority: currentTask.priority ?? 100,
              delay: delayMs,
            });
            publishEvent({
              type: "task:pending_reason",
              taskId,
              data: { pendingReason: "waiting_for_off_peak" },
            });
            return;
          }
        }

        // ── Serialized concurrency check + claim ─────────────────────
        // The claim lock ensures only one worker at a time checks
        // counts and claims a task. Without this, N workers all see
        // 0 running (pre-check race), all claim (provisioning), then
        // all fail the post-check and re-queue — creating 2N state
        // events per cycle that repeat every 10s ("event storm") and
        // preventing ANY task from ever running.

        // Compute effective concurrency: maxAgentsPerPod * maxPodInstances
        const maxAgentsPerPod = repoConfig?.maxAgentsPerPod ?? 2;
        const maxPodInstances = repoConfig?.maxPodInstances ?? 1;
        const effectiveRepoConcurrency = maxAgentsPerPod * maxPodInstances;

        const claimed = await withClaimLock(async () => {
          const globalMax = parseInt(process.env.OPTIO_MAX_CONCURRENT ?? "5", 10);

          // Global concurrency check
          const [{ count: activeCount }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(tasks)
            .where(sql`${tasks.state} IN ('provisioning', 'running')`);
          if (Number(activeCount) >= globalMax) {
            log.info({ activeCount, globalMax }, "Global concurrency saturated, re-scheduling");
            return null;
          }

          // Per-repo concurrency: use pod-based limit (pods * agents per pod).
          // maxConcurrentTasks is a legacy field — if set, take the lower of
          // the two to respect both the pod capacity and the explicit cap.
          const repoMax = repoConfig?.maxConcurrentTasks
            ? Math.min(repoConfig.maxConcurrentTasks, effectiveRepoConcurrency)
            : effectiveRepoConcurrency;
          const [{ count: repoCount }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(tasks)
            .where(
              sql`${tasks.repoUrl} = ${currentTask.repoUrl} AND ${tasks.state} IN ('provisioning', 'running')`,
            );
          if (Number(repoCount) >= repoMax) {
            log.info(
              { repoActiveCount: repoCount, max: repoMax },
              "Repo concurrency saturated, re-scheduling",
            );
            return null;
          }

          // Claim — atomic conditional update (queued → provisioning)
          return taskService.tryTransitionTask(taskId, TaskState.PROVISIONING, "worker_pickup");
        });

        if (!claimed) {
          const jitter = Math.floor(Math.random() * 5000);
          await taskQueue.add(
            "process-task",
            injectTraceContextIntoJob(job.data as Record<string, unknown>),
            {
              jobId: `${taskId}-delayed-${Date.now()}`,
              priority: currentTask.priority ?? 100,
              delay: 10000 + jitter,
            },
          );
          return;
        }
        log.info("Provisioning");

        // Get task details
        const task = await taskService.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        // Get agent adapter and build config
        const adapter = getAdapter(task.agentType);
        const claudeAuthMode =
          ((await retrieveSecretWithFallback("CLAUDE_AUTH_MODE", "global", taskWorkspaceId).catch(
            () => null,
          )) as any) ?? "api-key";
        const codexAuthMode =
          ((await retrieveSecretWithFallback("CODEX_AUTH_MODE", "global", taskWorkspaceId).catch(
            () => null,
          )) as any) ?? "api-key";
        const codexAppServerUrl =
          codexAuthMode === "app-server"
            ? (((await retrieveSecretWithFallback(
                "CODEX_APP_SERVER_URL",
                "global",
                taskWorkspaceId,
              ).catch(() => null)) as any) ?? undefined)
            : undefined;
        const geminiAuthMode =
          ((await retrieveSecretWithFallback("GEMINI_AUTH_MODE", "global", taskWorkspaceId).catch(
            () => null,
          )) as any) ?? "api-key";
        const googleCloudProject =
          geminiAuthMode === "vertex-ai"
            ? (((await retrieveSecretWithFallback(
                "GOOGLE_CLOUD_PROJECT",
                "global",
                taskWorkspaceId,
              ).catch(() => null)) as any) ?? undefined)
            : undefined;
        const googleCloudLocation =
          geminiAuthMode === "vertex-ai"
            ? (((await retrieveSecretWithFallback(
                "GOOGLE_CLOUD_LOCATION",
                "global",
                taskWorkspaceId,
              ).catch(() => null)) as any) ?? undefined)
            : undefined;
        const opencodeDefaultBaseUrl =
          ((await retrieveSecretWithFallback(
            "OPENCODE_DEFAULT_BASE_URL",
            "global",
            taskWorkspaceId,
          ).catch(() => null)) as any) ?? undefined;
        const opencodeDefaultModel =
          ((await retrieveSecretWithFallback(
            "OPENCODE_DEFAULT_MODEL",
            "global",
            taskWorkspaceId,
          ).catch(() => null)) as any) ?? undefined;
        const optioApiUrl = `http://${process.env.API_HOST ?? "host.docker.internal"}:${process.env.API_PORT ?? "4000"}`;

        // Load and render prompt template
        const promptConfig = await getPromptTemplate(task.repoUrl);

        // repoConfig already loaded above for concurrency check

        const parsedRepo = parseRepoUrl(task.repoUrl);
        const repoName = parsedRepo
          ? `${parsedRepo.owner}/${parsedRepo.repo}`
          : task.repoUrl.replace(/.*[/:]([^/]+\/[^/.]+).*/, "$1");
        const isGitLab = parsedRepo?.platform === "gitlab";
        const branchName = `${TASK_BRANCH_PREFIX}${task.id}`;
        const taskFilePath = TASK_FILE_PATH;

        // Enable planning mode for fresh runs (not resumed) when repo has it enabled
        const isPlanningRun =
          !!repoConfig?.planningModeEnabled && !resumeSessionId && !reviewOverride;

        const renderedPrompt = renderPromptTemplate(promptConfig.template, {
          TASK_FILE: taskFilePath,
          BRANCH_NAME: branchName,
          TASK_ID: task.id,
          TASK_TITLE: task.title,
          REPO_NAME: repoName,
          AUTO_MERGE: String(promptConfig.autoMerge),
          DRAFT_PR: String(promptConfig.cautiousMode),
          ISSUE_NUMBER: task.ticketExternalId ?? "",
          GIT_PLATFORM_GITLAB: isGitLab ? "true" : "",
          PLANNING_MODE: isPlanningRun ? "true" : "",
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
          codexAuthMode,
          codexAppServerUrl,
          optioApiUrl,
          renderedPrompt: finalRenderedPrompt,
          taskFileContent: finalTaskFileContent,
          taskFilePath: finalTaskFilePath,
          claudeModel: finalClaudeModel,
          claudeContextWindow: repoConfig?.claudeContextWindow ?? undefined,
          claudeThinking: repoConfig?.claudeThinking ?? undefined,
          claudeEffort: repoConfig?.claudeEffort ?? undefined,
          copilotModel: repoConfig?.copilotModel ?? undefined,
          copilotEffort: repoConfig?.copilotEffort ?? undefined,
          opencodeModel: repoConfig?.opencodeModel ?? opencodeDefaultModel,
          opencodeAgent: repoConfig?.opencodeAgent ?? undefined,
          opencodeBaseUrl: repoConfig?.opencodeBaseUrl ?? opencodeDefaultBaseUrl,
          geminiAuthMode,
          geminiModel: repoConfig?.geminiModel ?? undefined,
          geminiApprovalMode:
            (repoConfig?.geminiApprovalMode as "default" | "auto_edit" | "yolo") ?? undefined,
          maxTurnsCoding: repoConfig?.maxTurnsCoding ?? undefined,
          maxTurnsReview: repoConfig?.maxTurnsReview ?? undefined,
          googleCloudProject,
          googleCloudLocation,
        });

        // ── MCP servers & custom skills injection ────────────────────
        const { getMcpServersForTask, buildMcpJsonContent } =
          await import("../services/mcp-server-service.js");
        const { getSkillsForTask, buildSkillSetupFiles } =
          await import("../services/skill-service.js");

        const mcpServers = await getMcpServersForTask(task.repoUrl, taskWorkspaceId);
        if (mcpServers.length > 0) {
          const mcpJsonContent = await buildMcpJsonContent(mcpServers, task.repoUrl);
          agentConfig.setupFiles = agentConfig.setupFiles ?? [];
          agentConfig.setupFiles.push({
            path: ".mcp.json",
            content: mcpJsonContent,
          });

          // Collect install commands
          const installCommands = mcpServers
            .filter((s) => s.installCommand)
            .map((s) => s.installCommand!);
          if (installCommands.length > 0) {
            agentConfig.env.OPTIO_MCP_INSTALL_COMMANDS = installCommands.join(" && ");
          }
          log.info({ count: mcpServers.length }, "Injecting MCP servers");
        }

        // ── Connection-based MCP injection ─────────────────────────
        const { getConnectionsForTask } = await import("../services/connection-service.js");
        const resolvedConnections = await getConnectionsForTask(
          task.repoUrl,
          task.agentType,
          taskWorkspaceId,
        );
        if (resolvedConnections.length > 0) {
          // Build MCP entries from connections and merge into .mcp.json
          const connectionMcpEntries: Record<
            string,
            { command: string; args: string[]; env?: Record<string, string> }
          > = {};
          const connectionInstallCommands: string[] = [];

          for (const conn of resolvedConnections) {
            if (!conn.mcpConfig) continue;
            const mcpCfg = conn.mcpConfig;

            // Resolve env vars by mapping config values through envMapping
            const resolvedEnv: Record<string, string> = {};
            for (const [envKey, configKey] of Object.entries(mcpCfg.envMapping)) {
              const value = conn.config[configKey];
              if (typeof value === "string") {
                // Check if it's a secret reference
                if (value.startsWith("${{") && value.endsWith("}}")) {
                  const secretName = value.slice(3, -2).trim();
                  try {
                    let secretValue: string;
                    try {
                      secretValue = await retrieveSecretWithFallback(
                        secretName,
                        task.repoUrl,
                        taskWorkspaceId,
                      );
                    } catch {
                      secretValue = await retrieveSecretWithFallback(
                        secretName,
                        "global",
                        taskWorkspaceId,
                      );
                    }
                    resolvedEnv[envKey] = secretValue;
                  } catch {
                    // Secret not found — try the config key as a secret name directly
                    try {
                      resolvedEnv[envKey] = await retrieveSecretWithFallback(
                        configKey,
                        task.repoUrl,
                        taskWorkspaceId,
                      );
                    } catch {
                      try {
                        resolvedEnv[envKey] = await retrieveSecretWithFallback(
                          configKey,
                          "global",
                          taskWorkspaceId,
                        );
                      } catch {
                        // Leave unresolved
                      }
                    }
                  }
                } else {
                  resolvedEnv[envKey] = value;
                }
              } else {
                // Try resolving the config key as a secret name
                try {
                  resolvedEnv[envKey] = await retrieveSecretWithFallback(
                    configKey,
                    task.repoUrl,
                    taskWorkspaceId,
                  );
                } catch {
                  try {
                    resolvedEnv[envKey] = await retrieveSecretWithFallback(
                      configKey,
                      "global",
                      taskWorkspaceId,
                    );
                  } catch {
                    // Leave unresolved
                  }
                }
              }
            }

            // Resolve template args (e.g., {{ROOT_PATH}})
            const resolvedArgs = mcpCfg.args.map((arg) =>
              arg.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
                const val = conn.config[key];
                return typeof val === "string" ? val : arg;
              }),
            );

            connectionMcpEntries[conn.connectionName] = {
              command: mcpCfg.command,
              args: resolvedArgs,
              ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
            };

            if (mcpCfg.installCommand) {
              connectionInstallCommands.push(mcpCfg.installCommand);
            }
          }

          if (Object.keys(connectionMcpEntries).length > 0) {
            // Find existing .mcp.json in setup files and merge, or create new
            agentConfig.setupFiles = agentConfig.setupFiles ?? [];
            const existingIdx = agentConfig.setupFiles.findIndex((f) => f.path === ".mcp.json");

            if (existingIdx >= 0) {
              // Merge with existing MCP servers
              const existing = JSON.parse(agentConfig.setupFiles[existingIdx].content);
              existing.mcpServers = {
                ...existing.mcpServers,
                ...connectionMcpEntries,
              };
              agentConfig.setupFiles[existingIdx].content = JSON.stringify(existing, null, 2);
            } else {
              agentConfig.setupFiles.push({
                path: ".mcp.json",
                content: JSON.stringify({ mcpServers: connectionMcpEntries }, null, 2),
              });
            }

            // Merge install commands
            if (connectionInstallCommands.length > 0) {
              const existing = agentConfig.env.OPTIO_MCP_INSTALL_COMMANDS;
              agentConfig.env.OPTIO_MCP_INSTALL_COMMANDS = existing
                ? `${existing} && ${connectionInstallCommands.join(" && ")}`
                : connectionInstallCommands.join(" && ");
            }

            log.info(
              { count: Object.keys(connectionMcpEntries).length },
              "Injecting connections as MCP servers",
            );
          }
        }

        const skills = await getSkillsForTask(task.repoUrl, taskWorkspaceId);
        if (skills.length > 0) {
          agentConfig.setupFiles = agentConfig.setupFiles ?? [];
          const skillFiles = buildSkillSetupFiles(skills);
          agentConfig.setupFiles.push(...skillFiles);
          log.info({ count: skills.length }, "Injecting custom skills");
        }

        // Encode setup files
        if (agentConfig.setupFiles && agentConfig.setupFiles.length > 0) {
          agentConfig.env.OPTIO_SETUP_FILES = Buffer.from(
            JSON.stringify(agentConfig.setupFiles),
          ).toString("base64");
        }

        // Resolve secrets (workspace → repo-scoped → global fallback)
        // Only require GITHUB_TOKEN when GitHub App auth is not configured
        const secretNames = [
          ...new Set([
            ...agentConfig.requiredSecrets,
            ...(!isGitHubAppConfigured() ? ["GITHUB_TOKEN"] : []),
          ]),
        ];
        const resolvedSecrets = await resolveSecretsForTask(
          secretNames,
          task.repoUrl,
          taskWorkspaceId,
        );
        const allEnv: Record<string, string> = { ...agentConfig.env, ...resolvedSecrets };

        // Resolve git platform tokens (not part of adapter requiredSecrets since they're infra-level)
        for (const secretName of ["GITHUB_TOKEN", "GITLAB_TOKEN", "GITLAB_HOST"]) {
          if (!allEnv[secretName]) {
            const val = await retrieveSecretWithFallback(
              secretName,
              "global",
              taskWorkspaceId,
            ).catch(() => null);
            if (val) allEnv[secretName] = val as string;
          }
        }

        // Inject credential URLs for dynamic GitHub token resolution.
        // OPTIO_API_INTERNAL_URL is the K8s service URL (set by Helm chart).
        // Falls back to localhost for local dev where API_HOST is the bind address.
        const apiInternalUrl =
          process.env.OPTIO_API_INTERNAL_URL ??
          `http://localhost:${process.env.API_PORT ?? "4000"}`;
        // Pod-level URL (no taskId): used by repo-init.sh for git clone with installation token
        allEnv.OPTIO_GIT_CREDENTIAL_URL = `${apiInternalUrl}/api/internal/git-credentials`;
        // Task-level URL (with taskId): injected at exec time for user-scoped git operations
        allEnv.OPTIO_GIT_TASK_CREDENTIAL_URL = `${apiInternalUrl}/api/internal/git-credentials?taskId=${task.id}`;
        // Shared secret for authenticating credential requests from pods
        allEnv.OPTIO_CREDENTIAL_SECRET = getCredentialSecret();

        // Only inject static GITHUB_TOKEN when GitHub App is not configured
        // and the credential helper scripts may not be available (old images)
        if (isGitHubAppConfigured() && allEnv.GITHUB_TOKEN) {
          delete allEnv.GITHUB_TOKEN;
        }

        // Force-restart: tell the exec script to use the existing PR branch
        if (restartFromBranch) {
          allEnv.OPTIO_RESTART_FROM_BRANCH = "true";
        }

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

        // For oauth-token mode, read the token from the secrets store
        if (claudeAuthMode === "oauth-token") {
          // Pre-flight: check the cached validation from the background worker
          // to fail fast before wasting ~10s on pod provisioning + worktree setup
          try {
            const { getCachedTokenValidation } = await import("./token-validation-worker.js");
            const cached = await getCachedTokenValidation();
            if (cached?.tokenExists && !cached.valid) {
              throw new Error(
                "Claude OAuth token is expired (detected by pre-flight validation). " +
                  "Go to Secrets to update CLAUDE_CODE_OAUTH_TOKEN, or re-run 'claude setup-token'.",
              );
            }
          } catch (preflight) {
            // Re-throw if it's our own validation error; swallow infra errors
            if (preflight instanceof Error && preflight.message.includes("pre-flight")) {
              throw preflight;
            }
          }

          const oauthToken = await retrieveSecretWithFallback(
            "CLAUDE_CODE_OAUTH_TOKEN",
            "global",
            taskWorkspaceId,
          ).catch(() => null);
          if (oauthToken) {
            allEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken as string;
            log.info("Injected CLAUDE_CODE_OAUTH_TOKEN from secrets store");
          } else {
            throw new Error(
              "OAuth token mode selected but no CLAUDE_CODE_OAUTH_TOKEN secret found. " +
                "Run `claude setup-token` and paste the token in the setup wizard.",
            );
          }
        }

        // Split env into pod-level (for repo-init.sh) and task-level (for exec).
        // Pod env must NOT contain user-specific secrets (API keys, OAuth tokens)
        // since the pod is shared across users. Secrets are only in task exec env.
        const podEnv: Record<string, string> = {
          OPTIO_GIT_CREDENTIAL_URL: allEnv.OPTIO_GIT_CREDENTIAL_URL,
          OPTIO_CREDENTIAL_SECRET: allEnv.OPTIO_CREDENTIAL_SECRET,
          ...(allEnv.GITHUB_TOKEN ? { GITHUB_TOKEN: allEnv.GITHUB_TOKEN } : {}),
          ...(allEnv.GITLAB_TOKEN ? { GITLAB_TOKEN: allEnv.GITLAB_TOKEN } : {}),
          ...(allEnv.GITLAB_HOST ? { GITLAB_HOST: allEnv.GITLAB_HOST } : {}),
          ...(process.env.GITHUB_APP_BOT_NAME
            ? { GITHUB_APP_BOT_NAME: process.env.GITHUB_APP_BOT_NAME }
            : {}),
          ...(process.env.GITHUB_APP_BOT_EMAIL
            ? { GITHUB_APP_BOT_EMAIL: process.env.GITHUB_APP_BOT_EMAIL }
            : {}),
          ...(allEnv.OPTIO_EXTRA_PACKAGES
            ? { OPTIO_EXTRA_PACKAGES: allEnv.OPTIO_EXTRA_PACKAGES }
            : {}),
          ...(allEnv.OPTIO_SETUP_COMMANDS
            ? { OPTIO_SETUP_COMMANDS: allEnv.OPTIO_SETUP_COMMANDS }
            : {}),
        };

        // Get or create a repo pod (with multi-pod scheduling)
        log.info("Getting repo pod");
        const isRetry = (task.retryCount ?? 0) > 0;
        const imageConfig = repoConfig
          ? { preset: (repoConfig.imagePreset ?? "base") as PresetImageId }
          : undefined;
        const pod = await repoPool.getOrCreateRepoPod(
          task.repoUrl,
          task.repoBranch,
          podEnv,
          imageConfig,
          {
            preferredPodId: isRetry ? ((task as any).lastPodId ?? undefined) : undefined,
            maxAgentsPerPod,
            maxPodInstances,
            networkPolicy: repoConfig?.networkPolicy ?? "unrestricted",
            cpuRequest: repoConfig?.cpuRequest,
            cpuLimit: repoConfig?.cpuLimit,
            memoryRequest: repoConfig?.memoryRequest,
            memoryLimit: repoConfig?.memoryLimit,
            dockerInDocker: repoConfig?.dockerInDocker ?? false,
            secretProxy: repoConfig?.secretProxy ?? false,
            workspaceId: taskWorkspaceId,
          },
        );
        repoPodId = pod.id;
        log.info({ podName: pod.podName, instanceIndex: pod.instanceIndex }, "Repo pod ready");

        await taskService.updateTaskContainer(taskId, pod.podName ?? pod.podId ?? pod.id);
        await taskService.transitionTask(taskId, TaskState.RUNNING, "worktree_created");
        log.info("Running agent in worktree");

        // ── Check for existing PR before launching agent ───────────────
        // If a previous run already opened a PR for this task's branch,
        // skip the agent entirely and transition straight to pr_opened.
        // This avoids wasting compute on tasks killed by restarts/reconcile.
        const isReviewTask0 =
          !!reviewOverride || task.taskType === "review" || task.taskType === "pr_review";
        if (!restartFromBranch && !resumeSessionId && !isReviewTask0) {
          const existingPr = await checkExistingPr(task.repoUrl, taskId, taskWorkspaceId);
          if (existingPr) {
            log.info(
              { prUrl: existingPr.url, prNumber: existingPr.number },
              "Existing PR found — skipping agent, transitioning to pr_opened",
            );
            await taskService.updateTaskPr(taskId, existingPr.url);
            await repoPool.updateWorktreeState(taskId, "preserved");
            await taskService.transitionTask(
              taskId,
              TaskState.PR_OPENED,
              "existing_pr_detected",
              existingPr.url,
            );
            return;
          }
        }

        // Build the agent command based on type
        const isReviewTask =
          !!reviewOverride || task.taskType === "review" || task.taskType === "pr_review";
        const agentCommand = buildAgentCommand(task.agentType, allEnv, {
          resumeSessionId,
          resumePrompt,
          isReview: isReviewTask,
          maxTurnsCoding: repoConfig?.maxTurnsCoding ?? undefined,
          maxTurnsReview: repoConfig?.maxTurnsReview ?? undefined,
        });

        // Execute the task in the repo pod via worktree
        // On retry to the same pod, reset existing worktree instead of recreating
        const shouldResetWorktree = isRetry && pod.id === (task as any).lastPodId;
        const execSession = await repoPool.execTaskInRepoPod(pod, task.id, agentCommand, allEnv, {
          resetWorktree: shouldResetWorktree,
        });

        // Claude runs with `--input-format stream-json`, which means the initial
        // user message must come in over stdin — the -p/--print positional arg is
        // ignored in that mode. The pipe buffer holds this line until bash finishes
        // its setup and execs claude, so it's safe to write immediately.
        if (task.agentType === "claude-code") {
          try {
            execSession.stdin.write(buildInitialClaudeStreamMessage(allEnv.OPTIO_PROMPT ?? ""));
          } catch (err) {
            log.warn({ err }, "Failed to write initial prompt to claude stdin");
          }
        }

        // Stream stdout with structured parsing
        let allLogs = "";
        let sessionId: string | undefined;
        // For force-restart, preserve the existing PR URL so agent output
        // referencing other repos' PRs doesn't overwrite it
        let capturedPrUrl: string | undefined = restartFromBranch
          ? (task.prUrl ?? undefined)
          : undefined;
        let lastHeartbeat = Date.now();
        const HEARTBEAT_INTERVAL_MS = 60_000;
        // Stall detection: debounced activity timestamp flush
        let pendingActivityAt: Date | null = null;
        let lastActivityFlushAt = 0;
        const ACTIVITY_FLUSH_INTERVAL_MS = 5_000;
        // Buffer for partial NDJSON lines split across chunks
        let lineBuf = "";

        // Subscribe to mid-task messages from users (only for claude-code)
        let messageSubscription: { unsubscribe: () => void } | undefined;
        if (task.agentType === "claude-code") {
          messageSubscription = subscribeToTaskMessages(taskId, async (payload) => {
            try {
              // Format the message text — prefix with interrupt marker if needed
              let text = payload.content;
              if (payload.mode === "interrupt") {
                text = `[URGENT INTERRUPT FROM USER — stop what you are doing and address this immediately] ${text}`;
              }

              // Write stream-json NDJSON line to stdin
              const streamJsonMsg = JSON.stringify({
                type: "user",
                message: {
                  role: "user",
                  content: [{ type: "text", text }],
                },
              });
              execSession.stdin.write(streamJsonMsg + "\n");

              // Mark as delivered
              await messageService.markDelivered(payload.messageId);
              await publishEvent({
                type: "task:message_delivered",
                taskId,
                messageId: payload.messageId,
                timestamp: new Date().toISOString(),
              });
            } catch (err) {
              log.warn({ messageId: payload.messageId, err }, "Failed to deliver task message");
              await messageService
                .markDeliveryError(
                  payload.messageId,
                  err instanceof Error ? err.message : "delivery failed",
                )
                .catch(() => {});
            }
          });
        }

        // Capture stderr for diagnostics (e.g. bash parse errors, git warnings)
        let stderrData = "";
        (async () => {
          for await (const chunk of execSession.stderr as AsyncIterable<Buffer>) {
            stderrData += chunk.toString();
          }
        })().catch(() => {});

        for await (const chunk of execSession.stdout as AsyncIterable<Buffer>) {
          const text = chunk.toString();
          allLogs += text;

          // Periodically bump tasks.updatedAt so the stale detector
          // knows this task is still actively streaming
          const now = Date.now();
          if (now - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
            await taskService.touchTaskHeartbeat(taskId);
            lastHeartbeat = now;
          }

          const parts = (lineBuf + text).split("\n");
          // Last element is either empty (text ended with \n) or a partial line
          lineBuf = parts.pop() ?? "";

          for (const line of parts) {
            if (!line.trim()) continue;

            // Parse as structured agent event (format depends on agent type)
            const parsed =
              task.agentType === "codex"
                ? parseCodexEvent(line, taskId)
                : task.agentType === "copilot"
                  ? parseCopilotEvent(line, taskId)
                  : task.agentType === "opencode"
                    ? parseOpenCodeEvent(line, taskId)
                    : task.agentType === "gemini"
                      ? parseGeminiEvent(line, taskId)
                      : task.agentType === "openclaw"
                        ? parseOpenClawEvent(line, taskId)
                        : parseClaudeEvent(line, taskId);
            if (parsed.sessionId && !sessionId) {
              sessionId = parsed.sessionId;
              await taskService.updateTaskSession(taskId, sessionId);
              log.info({ sessionId }, "Session ID captured");
            }
            // Terminal event (e.g. claude's `result` event) means the agent has
            // finished the turn. With --input-format stream-json claude keeps
            // stdin open waiting for another user message; closing stdin here
            // lets it exit cleanly so the task can transition to pr_opened /
            // completed / failed.
            if (parsed.isTerminal) {
              try {
                execSession.stdin.end();
              } catch (err) {
                log.warn({ err }, "Failed to close agent stdin on terminal event");
              }
            }
            for (const entry of parsed.entries) {
              await taskService.appendTaskLog(
                taskId,
                entry.content,
                "stdout",
                entry.type,
                entry.metadata,
              );

              // Stall detection: mark activity on meaningful parsed events
              if (["text", "tool_use", "tool_result", "thinking", "system"].includes(entry.type)) {
                pendingActivityAt = new Date();
              }

              // Check for PR URL — only capture the first PR URL from agent output
              // that matches the task's own repo. Without repo validation, the
              // agent referencing another repo's PR (e.g. via gh pr list on a
              // dependency) would store the wrong URL.
              if (!capturedPrUrl) {
                // Match both GitHub PR URLs and GitLab MR URLs (web URLs only, not API URLs)
                const prUrlPattern =
                  /https:\/\/(?![\w.-]+\/api\/)[^\s"]+\/(?:pull\/\d+|-\/merge_requests\/\d+)/g;
                const prMatches = entry.content.match(prUrlPattern);
                if (prMatches) {
                  const taskBranch = `optio/task-${taskId}`;
                  const content = entry.content.trim();
                  const looksLikeJsonArray =
                    content.startsWith("[") && content.includes('"number"');
                  // Filter to only URLs matching the task's repo using parsePrUrl
                  const taskRepo = parseRepoUrl(task.repoUrl);
                  const repoMatches = prMatches.filter((url) => {
                    const parsed = parsePrUrl(url);
                    if (!parsed || !taskRepo) return false;
                    return (
                      parsed.owner.toLowerCase() === taskRepo.owner.toLowerCase() &&
                      parsed.repo.toLowerCase() === taskRepo.repo.toLowerCase() &&
                      parsed.host === taskRepo.host
                    );
                  });
                  if (repoMatches.length > 0) {
                    if (!looksLikeJsonArray) {
                      const url = repoMatches[repoMatches.length - 1];
                      capturedPrUrl = url;
                      await taskService.updateTaskPr(taskId, url);
                      log.info({ prUrl: url }, "PR URL detected in logs");
                    } else if (entry.content.includes(taskBranch)) {
                      const url = repoMatches[repoMatches.length - 1];
                      capturedPrUrl = url;
                      await taskService.updateTaskPr(taskId, url);
                      log.info({ prUrl: url }, "PR URL detected in logs (own branch in JSON)");
                    }
                  }
                }
              }
            }
          }

          // Debounced flush of lastActivityAt to avoid per-event DB writes
          if (pendingActivityAt && Date.now() - lastActivityFlushAt > ACTIVITY_FLUSH_INTERVAL_MS) {
            await taskService.updateTaskActivity(taskId, pendingActivityAt);
            lastActivityFlushAt = Date.now();
            pendingActivityAt = null;
          }
        }

        // Final flush of pending activity timestamp
        if (pendingActivityAt) {
          await taskService.updateTaskActivity(taskId, pendingActivityAt);
          pendingActivityAt = null;
        }

        // Flush any remaining partial line in the buffer
        if (lineBuf.trim()) {
          const parsed =
            task.agentType === "codex"
              ? parseCodexEvent(lineBuf, taskId)
              : task.agentType === "copilot"
                ? parseCopilotEvent(lineBuf, taskId)
                : task.agentType === "opencode"
                  ? parseOpenCodeEvent(lineBuf, taskId)
                  : task.agentType === "gemini"
                    ? parseGeminiEvent(lineBuf, taskId)
                    : task.agentType === "openclaw"
                      ? parseOpenClawEvent(lineBuf, taskId)
                      : parseClaudeEvent(lineBuf, taskId);
          for (const entry of parsed.entries) {
            await taskService.appendTaskLog(
              taskId,
              entry.content,
              "stdout",
              entry.type,
              entry.metadata,
            );
          }
        }

        // Exec finished — clean up message subscription
        messageSubscription?.unsubscribe();

        // Exec finished — determine result
        if (stderrData) {
          log.warn({ stderrPreview: stderrData.slice(0, 500) }, "Exec stderr output");
        }
        // Before processing results, verify this worker still owns the task.
        // A force-redo may have reset the task while we were streaming.
        const taskAfterExec = await taskService.getTask(taskId);
        if (!taskAfterExec || taskAfterExec.state !== TaskState.RUNNING) {
          log.info(
            { currentState: taskAfterExec?.state },
            "Task state changed during execution — skipping final transition (likely force-redo)",
          );
          return;
        }

        // Detect exit code from logs (agent-type-specific patterns)
        const inferredExitCode = inferExitCode(task.agentType, allLogs);
        const result = adapter.parseResult(inferredExitCode, allLogs);
        await taskService.updateTaskResult(taskId, result.summary, result.error);

        // Persist cost, token usage, and model data
        const costFields: Record<string, unknown> = {};
        if (result.costUsd != null) costFields.costUsd = String(result.costUsd);
        if (result.inputTokens != null) costFields.inputTokens = result.inputTokens;
        if (result.outputTokens != null) costFields.outputTokens = result.outputTokens;
        if (result.model) costFields.modelUsed = result.model;
        if (Object.keys(costFields).length > 0) {
          await db.update(tasks).set(costFields).where(eq(tasks.id, taskId));
        }

        // ── Telemetry: record cost and token metrics ──────────────────
        const taskAttrs = {
          agent_type: task.agentType,
          model: result.model ?? "unknown",
          repo_url: task.repoUrl,
        };
        if (result.costUsd != null) {
          recordTaskCost(result.costUsd, taskAttrs);
          emitCostReportLog(
            taskId,
            result.costUsd,
            result.inputTokens ?? 0,
            result.outputTokens ?? 0,
            result.model ?? "unknown",
          );
        }
        if (result.inputTokens != null) {
          recordTaskTokens(result.inputTokens, { ...taskAttrs, direction: "input" });
        }
        if (result.outputTokens != null) {
          recordTaskTokens(result.outputTokens, { ...taskAttrs, direction: "output" });
        }

        // Pick the best PR URL.  Priority:
        //   1. capturedPrUrl — detected during streaming with repo validation
        //      and heuristics (branch matching, JSON-array filtering).
        //   2. taskAfterExec.prUrl — already persisted, e.g. preserved across
        //      a force-restart.
        //   3. result.prUrl — raw regex on the full NDJSON log; only used if
        //      it matches the task's repo (can otherwise match placeholder URLs
        //      inside code the agent wrote, or PRs from other repos).
        let fallbackPrUrl = result.prUrl;
        if (fallbackPrUrl) {
          const parsedPr = parsePrUrl(fallbackPrUrl);
          const taskRepo = parseRepoUrl(task.repoUrl);
          if (
            !parsedPr ||
            !taskRepo ||
            parsedPr.owner.toLowerCase() !== taskRepo.owner.toLowerCase() ||
            parsedPr.repo.toLowerCase() !== taskRepo.repo.toLowerCase() ||
            parsedPr.host !== taskRepo.host
          ) {
            log.info(
              { resultPrUrl: fallbackPrUrl, expectedRepo: task.repoUrl },
              "Ignoring result.prUrl — wrong repo",
            );
            fallbackPrUrl = undefined;
          }
        }
        const detectedPrUrl = capturedPrUrl || taskAfterExec?.prUrl || fallbackPrUrl;

        if (!sessionId && !isReviewTask) {
          // Agent never started — no session ID means no agent output was produced.
          await repoPool.updateWorktreeState(taskId, "dirty");
          await taskService.transitionTask(
            taskId,
            TaskState.FAILED,
            "agent_no_output",
            "Agent process exited without producing any output",
          );
          log.warn("Agent exited without output — no session ID captured");
        } else if (detectedPrUrl && !isReviewTask) {
          // PR exists — go to pr_opened regardless of exit code.
          if (detectedPrUrl !== taskAfterExec?.prUrl) {
            await taskService.updateTaskPr(taskId, detectedPrUrl);
          }
          // Preserve worktree for resume (pr_opened state needs it)
          await repoPool.updateWorktreeState(taskId, "preserved");
          await taskService.transitionTask(
            taskId,
            TaskState.PR_OPENED,
            "pr_detected",
            detectedPrUrl,
          );
          log.info({ prUrl: detectedPrUrl }, "PR opened");
        } else if (result.success || isReviewTask) {
          // For pr_review tasks, parse the structured review output before cleanup
          if (task.taskType === "pr_review") {
            try {
              const { parseReviewOutput } = await import("../services/pr-review-service.js");
              await parseReviewOutput(taskId);
            } catch (err) {
              log.warn({ err }, "Failed to parse pr_review output — draft may need manual editing");
            }
          }
          // Planning mode: agent finished planning — wait for human approval
          if (isPlanningRun && !isReviewTask) {
            await repoPool.updateWorktreeState(taskId, "preserved");
            await taskService.transitionTask(
              taskId,
              TaskState.NEEDS_ATTENTION,
              "plan_review",
              "Agent has created an implementation plan and is waiting for approval",
            );
            log.info("Planning phase complete — awaiting human review");
          } else {
            await repoPool.updateWorktreeState(taskId, "removed");
            await taskService.transitionTask(
              taskId,
              TaskState.COMPLETED,
              "agent_success",
              result.summary,
            );
            log.info("Task completed");
          }
        } else {
          // Before failing, check if a PR was actually created via the API.
          // Log-based PR detection can miss URLs (e.g. agent created a PR but
          // the URL wasn't in stdout, or repo validation filtered it out).
          let apiFallbackPr: ExistingPr | null = null;
          if (!isReviewTask) {
            try {
              apiFallbackPr = await checkExistingPr(task.repoUrl, taskId, taskWorkspaceId);
            } catch {
              // Non-fatal — proceed with failure
            }
          }

          if (apiFallbackPr) {
            // PR exists despite agent reporting failure — go to pr_opened so the
            // PR watcher can track CI/review and auto-resume works correctly.
            await taskService.updateTaskPr(taskId, apiFallbackPr.url);
            await repoPool.updateWorktreeState(taskId, "preserved");
            await taskService.transitionTask(
              taskId,
              TaskState.PR_OPENED,
              "pr_detected_api",
              apiFallbackPr.url,
            );
            log.info(
              { prUrl: apiFallbackPr.url, inferredError: result.error },
              "PR found via API fallback — transitioning to pr_opened instead of failed",
            );
          } else {
            await repoPool.updateWorktreeState(taskId, "dirty");
            await taskService.transitionTask(
              taskId,
              TaskState.FAILED,
              "agent_failure",
              result.error,
            );
            log.warn({ error: result.error }, "Task failed");

            // Publish global alert for auth failures so the UI can show a banner
            if (
              result.error &&
              /OAuth token|authentication_failed|token.*expired/i.test(result.error)
            ) {
              // Invalidate the usage cache so subsequent API calls return fresh data
              // instead of stale "healthy" results that hide the expiration
              const { invalidateUsageCache } = await import("../services/auth-service.js");
              invalidateUsageCache();

              await publishEvent({
                type: "auth:failed",
                message:
                  "Claude Code OAuth token has expired. Re-authenticate with 'claude auth login' and retry failed tasks.",
                timestamp: new Date().toISOString(),
              });
            }
          }
        }

        // If this is a subtask, check if parent should advance
        const completedTask = await taskService.getTask(taskId);
        if (completedTask?.parentTaskId) {
          const { onSubtaskComplete } = await import("../services/subtask-service.js");
          await onSubtaskComplete(taskId).catch((err) =>
            log.warn({ err }, "Failed to check parent subtask status"),
          );
        }

        // Handle task dependencies: auto-start dependents or cascade failure
        if (completedTask) {
          const depSvc = await import("../services/dependency-service.js");
          if (
            completedTask.state === TaskState.COMPLETED ||
            completedTask.state === TaskState.PR_OPENED
          ) {
            await depSvc
              .onDependencyComplete(taskId)
              .catch((err) => log.warn({ err }, "Failed to process dependency completions"));
          } else if (completedTask.state === TaskState.FAILED) {
            await depSvc
              .cascadeFailure(taskId)
              .catch((err) => log.warn({ err }, "Failed to cascade failure to dependents"));
          }
        }

        // ── Telemetry: record task completion metrics ─────────────────
        if (completedTask) {
          const terminalState = completedTask.state;
          recordTaskComplete({
            state: terminalState,
            agent_type: task.agentType,
            model: result.model ?? "unknown",
            repo_url: task.repoUrl,
          });
          // Duration from task creation to terminal state
          const startedAt = task.startedAt ?? task.createdAt;
          if (startedAt) {
            const durationS = (Date.now() - new Date(startedAt).getTime()) / 1000;
            recordTaskDuration(durationS, {
              terminal_state: terminalState,
              agent_type: task.agentType,
            });
          }
        }
      } catch (err) {
        // State race errors mean another worker claimed the task — not a real failure
        if (err instanceof taskService.StateRaceError) {
          log.info({ err: String(err) }, "Lost state race, skipping");
          return;
        }
        log.error({ err }, "Task worker error");
        try {
          // Only try to fail the task if it's still in a state we own.
          // A force-redo may have reset the task to queued while we were running.
          const currentTask = await taskService.getTask(taskId);
          if (currentTask && ["provisioning", "running"].includes(currentTask.state)) {
            await repoPool.updateWorktreeState(taskId, "dirty").catch(() => {});
            // If the task is still provisioning (pod never started), check if
            // the error is recoverable and we haven't exceeded the retry cap.
            if (currentTask.state === "provisioning") {
              const MAX_PROVISIONING_RETRIES = 3;
              const errStr = String(err);
              const classified = classifyError(errStr);
              const isUnrecoverable = !classified.retryable;
              const retriesExhausted = provisioningRetryCount >= MAX_PROVISIONING_RETRIES;

              if (isUnrecoverable || retriesExhausted) {
                const reason = isUnrecoverable
                  ? `Unrecoverable provisioning error (${classified.title})`
                  : `Provisioning failed after ${provisioningRetryCount} retries`;
                log.error(
                  { err: errStr, provisioningRetryCount, classified: classified.title },
                  reason,
                );
                await taskService.updateTaskResult(taskId, undefined, errStr);
                await taskService.transitionTask(
                  taskId,
                  TaskState.FAILED,
                  "provisioning_permanent_failure",
                  errStr,
                );
                return;
              }

              // Recoverable — re-queue with incremented retry counter
              log.warn(
                { err: errStr, provisioningRetryCount: provisioningRetryCount + 1 },
                "Pod provisioning failed, re-queuing task",
              );
              await taskService.updateTaskResult(taskId, undefined, errStr);
              await taskService.transitionTask(
                taskId,
                TaskState.QUEUED,
                "provisioning_retry",
                errStr,
              );
              const jitter = Math.floor(Math.random() * 5000);
              await taskQueue.add(
                "process-task",
                {
                  ...job.data,
                  provisioningRetryCount: provisioningRetryCount + 1,
                },
                {
                  jobId: `${taskId}-provretry-${Date.now()}`,
                  priority: currentTask.priority ?? 100,
                  delay: 30_000 + jitter,
                },
              );
              return;
            }
            await taskService.updateTaskResult(taskId, undefined, String(err));
            await taskService.transitionTask(taskId, TaskState.FAILED, "worker_error", String(err));
          } else {
            log.info(
              { currentState: currentTask?.state },
              "Task state changed — not marking as failed (likely force-redo)",
            );
          }
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
    }),
    {
      connection: connectionOpts,
      concurrency: parseInt(process.env.OPTIO_MAX_CONCURRENT ?? "5", 10),
      // Task jobs run for minutes/hours — BullMQ defaults (30s lock, 30s stall
      // check, max 1 stall) are far too aggressive and cause "job stalled" failures.
      lockDuration: 600_000, // 10 min lock
      stalledInterval: 300_000, // check for stalls every 5 min
      maxStalledCount: 3, // allow 3 stall detections before failing
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
  // Drain all BullMQ jobs from the previous worker instance.
  // On restart, any existing jobs are orphans — the worker that owned them
  // is gone. We wipe the queue and re-enqueue from DB state below.
  try {
    await taskQueue.obliterate({ force: true });
    logger.info("Obliterated stale task queue from previous worker");
  } catch (err) {
    logger.warn({ err }, "Failed to obliterate stale task queue");
  }

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

  // Provisioning/running tasks lost their exec session.
  // Before failing and re-queuing, kill any orphaned agent processes
  // left inside repo pods (the API restart severed the exec stream but
  // kubelet doesn't send SIGHUP to in-pod processes).
  for (const task of [...orphanedProvisioning, ...orphanedRunning]) {
    if ((task as any).lastPodId) {
      try {
        await repoPool.killOrphanedAgentInPod((task as any).lastPodId, task.id);
        await repoPool.updateWorktreeState(task.id, "removed");
      } catch (err) {
        logger.warn(
          { err, taskId: task.id, podId: (task as any).lastPodId },
          "Failed to kill orphaned agent during startup reconciliation",
        );
      }
    }
  }

  // Check if a PR was already opened —
  // if so, transition directly to pr_opened to avoid redoing work.
  for (const task of [...orphanedProvisioning, ...orphanedRunning]) {
    // Re-read the task to get its current state — it may have been
    // completed or cancelled between the initial query and now.
    const [current] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    if (!current || (current.state !== "running" && current.state !== "provisioning")) {
      logger.info(
        { taskId: task.id, state: current?.state ?? "deleted" },
        "Skipping reconciliation — task already transitioned",
      );
      continue;
    }

    const taskWsId = task.workspaceId ?? null;
    const isReview = task.taskType === "review";
    let existingPr = null;
    if (!isReview) {
      try {
        existingPr = await checkExistingPr(task.repoUrl, task.id, taskWsId);
      } catch {
        // Non-fatal — fall through to fail + re-queue
      }
    }

    if (existingPr && current.state === "running") {
      // running → pr_opened is a valid transition
      logger.info(
        { taskId: task.id, prUrl: existingPr.url },
        "Existing PR found during reconciliation — transitioning to pr_opened",
      );
      await taskService.updateTaskPr(task.id, existingPr.url);
      await taskService.transitionTask(
        task.id,
        TaskState.PR_OPENED,
        "startup_reconcile",
        existingPr.url,
      );
    } else if (existingPr && current.state === "provisioning") {
      // provisioning → pr_opened is NOT valid; fail → re-queue and
      // the pre-agent PR check will short-circuit it to pr_opened
      logger.info(
        { taskId: task.id, prUrl: existingPr.url },
        "Existing PR found during reconciliation (provisioning) — will detect on re-queue",
      );
      await taskService.updateTaskPr(task.id, existingPr.url);
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
        "Re-queued after server restart (PR already exists)",
      );
    } else {
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

  // Reset activeTaskCount on all repo pods to match actual running tasks.
  // The counter can drift if the server crashes before the finally block
  // in the task worker decrements it.
  const corrected = await repoPool.reconcileActiveTaskCounts();
  if (corrected > 0) {
    logger.info({ corrected }, "Reconciled repo pod activeTaskCounts on startup");
  }

  // Re-check waiting_on_deps tasks — their dependencies may have completed
  // while the server was down.
  const waitingTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.state, "waiting_on_deps" as any));

  if (waitingTasks.length > 0) {
    const { areDependenciesMet } = await import("../services/dependency-service.js");
    let unblocked = 0;
    for (const task of waitingTasks) {
      const met = await areDependenciesMet(task.id);
      if (met) {
        await taskService.transitionTask(task.id, TaskState.QUEUED, "deps_met_on_startup");
        await taskQueue.add(
          "process-task",
          { taskId: task.id },
          {
            jobId: `${task.id}-deps-reconcile-${Date.now()}`,
            priority: task.priority ?? 100,
          },
        );
        unblocked++;
      }
    }
    if (unblocked > 0) {
      logger.info({ unblocked }, "Unblocked waiting_on_deps tasks after startup reconciliation");
    }
  }
}

/**
 * Build the initial user message NDJSON line that gets written to claude's stdin
 * when running with `--input-format stream-json`. In that mode the positional
 * `-p <prompt>` arg is ignored — the first user message must arrive via stdin.
 *
 * The trailing newline is required: stream-json is NDJSON (one JSON object per
 * line) and claude won't process a message until it sees the line terminator.
 */
export function buildInitialClaudeStreamMessage(prompt: string): string {
  return (
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    }) + "\n"
  );
}

export function buildAgentCommand(
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
  // Build the final prompt. For resume, prepend the resume text to the original.
  // The prompt is passed via $OPTIO_PROMPT env var (set by the base64-decoded env block)
  // to avoid bash interpreting command substitutions in the prompt text (e.g. heredocs).
  if (opts?.resumePrompt) {
    // Override OPTIO_PROMPT with the combined resume + original prompt
    const combined = `${opts.resumePrompt}\n\n---\n\nOriginal task prompt for context:\n${env.OPTIO_PROMPT}`;
    env.OPTIO_PROMPT = combined;
  }
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

      // Build --model flag from env vars set by the adapter
      const modelName = env.OPTIO_CLAUDE_MODEL;
      const ctxWindow = env.OPTIO_CLAUDE_CONTEXT_WINDOW;
      let modelFlag = "";
      if (modelName) {
        const ctx = ctxWindow === "1m" ? "[1m]" : "";
        modelFlag = `--model ${modelName}${ctx}`;
      }

      return [
        ...authSetup,
        `echo "[optio] Running Claude Code${opts?.isReview ? " (review)" : ""}..."`,
        // --input-format stream-json makes claude read user messages from stdin.
        // In this mode the -p positional arg is ignored, so we intentionally use
        // the boolean --print flag and deliver the initial prompt to stdin from
        // the task worker (see writeInitialClaudeMessage).
        `claude --print \\`,
        `  --dangerously-skip-permissions \\`,
        `  --input-format stream-json \\`,
        `  --output-format stream-json \\`,
        `  --replay-user-messages \\`,
        `  --verbose \\`,
        `  --max-turns ${maxTurns} \\`,
        `  ${modelFlag} ${resumeFlag}`.trim(),
      ];
    }
    case "codex": {
      const appServerFlag =
        env.OPTIO_CODEX_AUTH_MODE === "app-server" && env.OPTIO_CODEX_APP_SERVER_URL
          ? ` --app-server ${JSON.stringify(env.OPTIO_CODEX_APP_SERVER_URL)}`
          : "";
      return [
        `echo "[optio] Running OpenAI Codex${appServerFlag ? " (app-server)" : ""}..."`,
        `codex exec --full-auto "$OPTIO_PROMPT"${appServerFlag} --json`,
      ];
    }
    case "copilot": {
      const modelFlag = env.COPILOT_MODEL ? ` --model ${JSON.stringify(env.COPILOT_MODEL)}` : "";
      const effortFlag = env.COPILOT_EFFORT ? ` --effort ${env.COPILOT_EFFORT}` : "";
      return [
        `echo "[optio] Running GitHub Copilot..."`,
        `copilot --autopilot --yolo --max-autopilot-continues ${maxTurns} \\`,
        `  --output-format json --no-ask-user${modelFlag}${effortFlag} \\`,
        `  -p "$OPTIO_PROMPT"`,
      ];
    }
    case "opencode": {
      const modelFlag = env.OPTIO_OPENCODE_MODEL
        ? ` --model ${JSON.stringify(env.OPTIO_OPENCODE_MODEL)}`
        : "";
      const agentFlag = env.OPTIO_OPENCODE_AGENT
        ? ` --agent ${JSON.stringify(env.OPTIO_OPENCODE_AGENT)}`
        : "";
      const resumeFlag = opts?.resumeSessionId
        ? ` --session ${JSON.stringify(opts.resumeSessionId)}`
        : "";
      return [
        `echo "[optio] Running OpenCode (experimental)..."`,
        `opencode run --format json${modelFlag}${agentFlag}${resumeFlag} "$OPTIO_PROMPT"`,
      ];
    }
    case "gemini": {
      const geminiModelFlag = env.OPTIO_GEMINI_MODEL
        ? ` -m ${JSON.stringify(env.OPTIO_GEMINI_MODEL)}`
        : "";
      return [
        `echo "[optio] Running Google Gemini${opts?.isReview ? " (review)" : ""}..."`,
        `gemini -p "$OPTIO_PROMPT" \\`,
        `  --output-format stream-json \\`,
        `  --approval-mode yolo${geminiModelFlag}`,
      ];
    }
    case "openclaw": {
      const openclawModelFlag = env.OPTIO_OPENCLAW_MODEL
        ? ` --model ${JSON.stringify(env.OPTIO_OPENCLAW_MODEL)}`
        : "";
      const openclawAgentFlag = env.OPTIO_OPENCLAW_AGENT
        ? ` --agent ${JSON.stringify(env.OPTIO_OPENCLAW_AGENT)}`
        : "";
      return [
        `echo "[optio] Running OpenClaw (experimental)..."`,
        `openclaw agent --output-format stream-json${openclawModelFlag}${openclawAgentFlag} "$OPTIO_PROMPT"`,
      ];
    }
    default:
      return [`echo "Unknown agent type: ${agentType}" && exit 1`];
  }
}

/** Infer exit code from agent logs based on agent-specific error patterns */
export function inferExitCode(agentType: string, logs: string): number {
  switch (agentType) {
    case "codex": {
      // Codex: look for error events in JSON output or OpenAI-specific failures
      const hasErrorEvent = logs.includes('"type":"error"') || logs.includes('"type": "error"');
      const hasApiErrorEnvelope = /"error"\s*:\s*\{\s*"message"/.test(logs);
      const hasAuthError =
        /OPENAI_API_KEY|invalid.*api.?key|unauthorized|authentication.*failed/i.test(logs);
      const hasQuotaError = /quota|insufficient_quota|billing/i.test(logs);
      const hasModelError = /model_not_found|model.*not found|does not exist.*model/i.test(logs);
      const hasContentFilter = /content.?filter|content.?policy|safety.?system/i.test(logs);
      return hasErrorEvent ||
        hasApiErrorEnvelope ||
        hasAuthError ||
        hasQuotaError ||
        hasModelError ||
        hasContentFilter
        ? 1
        : 0;
    }
    case "copilot": {
      const hasResultError = logs.includes('"is_error":true') || logs.includes('"is_error": true');
      const hasErrorEvent = logs.includes('"type":"error"') || logs.includes('"type": "error"');
      const hasAuthError =
        /COPILOT_GITHUB_TOKEN|copilot.*auth|subscription.*required|unauthorized/i.test(logs);
      const hasFatalError =
        logs.includes("fatal:") || logs.includes("Error: authentication_failed");
      return hasResultError || hasErrorEvent || hasAuthError || hasFatalError ? 1 : 0;
    }
    case "opencode": {
      // OpenCode: similar to Codex — look for error events and provider-specific failures
      const hasErrorEvent = logs.includes('"type":"error"') || logs.includes('"type": "error"');
      const hasApiErrorEnvelope = /"error"\s*:\s*\{\s*"message"/.test(logs);
      const hasAuthError =
        /ANTHROPIC_API_KEY|OPENAI_API_KEY|GROQ_API_KEY|invalid.*api.?key|unauthorized|authentication.*failed/i.test(
          logs,
        );
      const hasModelError = /model_not_found|model.*not found|does not exist.*model/i.test(logs);
      const hasFatalError =
        logs.includes("fatal:") || logs.includes("Error: authentication_failed");
      return hasErrorEvent || hasApiErrorEnvelope || hasAuthError || hasModelError || hasFatalError
        ? 1
        : 0;
    }
    case "gemini": {
      const hasErrorEvent = logs.includes('"type":"error"') || logs.includes('"type": "error"');
      const hasAuthError = /GEMINI_API_KEY|GOOGLE_API_KEY|permission denied|unauthorized/i.test(
        logs,
      );
      const hasQuotaError = /quota|resource.?exhausted|rate.?limit/i.test(logs);
      const hasModelError = /model.*not found|model_not_found|does not exist.*model/i.test(logs);
      const hasTurnLimit = /turn.?limit|exit code 53/i.test(logs);
      return hasErrorEvent || hasAuthError || hasQuotaError || hasModelError || hasTurnLimit
        ? 1
        : 0;
    }
    case "openclaw": {
      // OpenClaw: similar to OpenCode — look for error events and provider-specific failures
      const hasErrorEvent = logs.includes('"type":"error"') || logs.includes('"type": "error"');
      const hasApiErrorEnvelope = /"error"\s*:\s*\{\s*"message"/.test(logs);
      const hasAuthError =
        /ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENCLAW_API_KEY|invalid.*api.?key|unauthorized|authentication.*failed/i.test(
          logs,
        );
      const hasModelError = /model_not_found|model.*not found|does not exist.*model/i.test(logs);
      const hasFatalError =
        logs.includes("fatal:") || logs.includes("Error: authentication_failed");
      return hasErrorEvent || hasApiErrorEnvelope || hasAuthError || hasModelError || hasFatalError
        ? 1
        : 0;
    }
    case "claude-code":
    default: {
      // Parse the NDJSON result event (authoritative source for Claude's exit status).
      // Raw string matching on the full logs produces false positives — e.g. "fatal:"
      // appearing in git command output that Claude ran and handled gracefully.
      for (const line of logs.split("\n")) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "result") {
            return ev.is_error ? 1 : 0;
          }
        } catch {
          // Not JSON — skip
        }
      }
      // No result event found — agent likely crashed before emitting one.
      // Fall back to heuristic checks on raw (non-JSON) output only.
      for (const line of logs.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          JSON.parse(trimmed);
          continue; // Skip JSON lines — errors inside tool output are not fatal
        } catch {
          // Raw output line — check for fatal errors
          if (trimmed.includes("fatal:") || trimmed.includes("Error: authentication_failed")) {
            return 1;
          }
        }
      }
      return 0;
    }
  }
}
