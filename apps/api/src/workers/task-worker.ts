import { workTraceability } from "../services/work-traceability.js";
import { piCommand } from "../utils/pi-command.js";
import { piProviderSecrets } from "../services/pi-provider-secrets.js";
import { runBudgetHold } from "../services/usage-budget-service.js";
import { workCredentialProfile } from "../services/pod-isolation.js";
import {
  credentialRuntime,
  resolveCredentialForWork,
} from "../services/agent-credential-service.js";
import { Worker, Queue } from "bullmq";
import {
  TaskState,
  TASK_BRANCH_PREFIX,
  renderPromptTemplate,
  shellSafeTitle,
  renderTaskFile,
  TASK_FILE_PATH,
  DEFAULT_MAX_TURNS_CODING,
  DEFAULT_MAX_TURNS_REVIEW,
  type PresetImageId,
  msUntilOffPeak,
  classifyError,
  parseRepoUrl,
  resolveRepoPlatform,
  parseIntEnv,
  PrToolCallTracker,
  shellQuote,
  describeError,
} from "@optio/shared";
import {
  getAdapter,
  OPENCODE_AUTO_APPROVE_FLAG,
  opencodeHeadlessEnabled,
} from "@optio/agent-adapters";
import { getEventParser } from "../services/event-parsers.js";
import { checkExistingPr, type ExistingPr } from "../services/pr-detection-service.js";
import { detectTaskPrs } from "../services/task-pr-service.js";
import { db } from "../db/client.js";
import { tasks, workRuns } from "../db/schema.js";
import { eq, sql, and } from "drizzle-orm";
import * as taskService from "../services/task-service.js";
import * as repoPool from "../services/repo-pool-service.js";
import { publishEvent } from "../services/event-bus.js";
import {
  resolveSecretsForTask,
  resolvePodSecrets,
  retrieveSecretWithFallback,
} from "../services/secret-service.js";
import { getPromptTemplate } from "../services/prompt-template-service.js";
import { podProviderRuntime, resolveProviderForWork } from "../services/model-provider-service.js";
import * as podPool from "../services/agent-pod-pool.js";
import { getRuntime } from "../services/container-service.js";
import {
  beginHold,
  closeAttachment,
  endOfLoss,
  endRunJob,
  onStreamError,
  readRunStderr,
  recordRunStarted,
  removeRunDirectory,
  runAttachJob,
  settleRun,
  streamRun,
  withStderr,
  type AttachRef,
  type AttachmentClaim,
  type AttachmentHold,
  type AttachedPod,
  type RunEnd,
} from "../services/run-attachment.js";
import { RunOutputDigest } from "../services/run-output-digest.js";
import { recordAuthEvent } from "../services/auth-failure-detector.js";
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

import { getBullMQOptions } from "../services/redis-config.js";
import {
  buildInitialClaudeStreamMessage,
  codexModelFlags,
} from "../services/pooled-agent-command.js";
import { addUsage } from "../services/run-usage.js";
import {
  buildAgentEnvironment,
  connectionShellEnv,
} from "../services/agent-environment-service.js";
import { EXPORT_CODEX_HOME } from "../utils/codex-config.js";
import {
  copilotMcpConfigFlag,
  EXPORT_GEMINI_HOME,
  EXPORT_OPENCODE_CONFIG,
  runHome,
} from "../utils/harness-config.js";
import { applyGitAccess, requiredGitTokenSecret } from "../services/git-access-env.js";
import { activityFlusher } from "../services/activity-flush.js";
import { TASK_CLAIM_KEY, withClaimLock } from "../services/claim-lock.js";

const bullmqOpts = getBullMQOptions();

export const taskQueue = new Queue("tasks", { ...bullmqOpts });

export function startTaskWorker() {
  const worker = new Worker(
    "tasks",
    instrumentWorkerProcessor("task-worker", async (job) => {
      // A re-attach (the reconciler's `reattach` action): the run is already
      // going in its pod; take it over from where its log rows stop.
      if (job.name === "attach-task") {
        await attachTask(job);
        return;
      }
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
          model?: string;
        };
      };
      const log = logger.child({ taskId, jobId: job.id });
      let repoPodId: string | null = null;
      // This job's hold on the run, from the claim on (run-attachment.ts);
      // the finally lets go of it through `endRunJob`.
      let hold: AttachmentHold | null = null;
      // The pod slot the run holds once its agent started; given back when
      // the run ends here. A run this job detached from keeps it for the
      // instance that finishes it.
      let slotHeld = false;
      let ended: RunEnd | null = null;
      // From the start exec on, a failure is the run's (its setup in the
      // pod), not provisioning's: no provisioning retry, as when the task
      // was already `running` for it.
      let startAttempted = false;

      try {
        // Verify task is in queued state before proceeding
        // (BullMQ may retry stale jobs from a previous failed attempt)
        const currentTask = await taskService.getTask(taskId);
        if (!currentTask || currentTask.state !== "queued") {
          log.info({ state: currentTask?.state }, "Skipping — task is not in queued state");
          return;
        }

        const budgetHold = await runBudgetHold("task", taskId);
        if (budgetHold) {
          await db
            .update(tasks)
            .set({ errorMessage: budgetHold, reconcileBackoffUntil: new Date(Date.now() + 60_000) })
            .where(eq(tasks.id, taskId));
          await taskQueue.add(job.name, job.data, {
            jobId: `${taskId}-budget-${Date.now()}`,
            delay: 60_000,
            removeOnComplete: true,
          });
          return;
        }
        await db
          .update(tasks)
          .set({ errorMessage: null })
          .where(
            and(eq(tasks.id, taskId), sql`${tasks.errorMessage} LIKE 'Usage budget reached:%'`),
          );

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

        // ── Local task: hand off to the owner's machine ───────────────
        // No repo pod, no worktree, no cluster concurrency: the Optio Local
        // daemon runs the agent in the task's directory and the terminal's
        // lifecycle drives the task's state (services/local-run-service.ts).
        // Resume jobs (CI failure / review feedback) carry the same
        // resumePrompt / resumeSessionId the pod path uses.
        if (currentTask.runTarget === "local") {
          const { dispatchLocalTask } = await import("../services/local-run-service.js");
          const terminal = await dispatchLocalTask(currentTask, { resumePrompt, resumeSessionId });
          log.info(
            { terminalId: terminal?.id ?? null, terminalState: terminal?.state ?? null },
            "Task dispatched to a local host",
          );
          return;
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
        // The claim lock (a Postgres advisory lock on the global limit,
        // services/claim-lock.ts) ensures only one worker — on any API
        // instance — at a time checks counts and claims a task; the repo's
        // own limit is counted under the same lock. Without it, N workers all see 0 running (pre-check race),
        // all claim (provisioning), then all fail the post-check and
        // re-queue — creating 2N state events per cycle that repeat every
        // 10s ("event storm") and preventing ANY task from ever running.

        // Compute effective concurrency: maxAgentsPerPod * maxPodInstances
        const maxAgentsPerPod = repoConfig?.maxAgentsPerPod ?? 2;
        const maxPodInstances = repoConfig?.maxPodInstances ?? 1;
        const effectiveRepoConcurrency = maxAgentsPerPod * maxPodInstances;

        // Null when another worker held the lock past its timeout: re-queue.
        const claimed = await withClaimLock([TASK_CLAIM_KEY], async (claim) => {
          const { tx } = claim;
          const globalMax = parseIntEnv("OPTIO_MAX_CONCURRENT", 5);

          // Global concurrency check
          const [{ count: activeCount }] = await tx
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
          const [{ count: repoCount }] = await tx
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

          // Claim — atomic conditional update (queued → provisioning) on
          // the lock's transaction, so it commits before the lock goes;
          // its announcement runs after the commit.
          return taskService.claimTransitionIn(
            claim,
            taskId,
            TaskState.PROVISIONING,
            "worker_pickup",
          );
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
        hold = await beginHold(taskRef(taskId));

        // Get task details
        const task = await taskService.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        // Get agent adapter and build config
        const adapter = getAdapter(task.agentType);
        // Personal work runs with its owner's secrets; organization work never
        // sees anyone's (see services/work-ownership.ts).
        const runOwnerUserId = task.ownerUserId ?? null;
        // A team's work runs with the team's secrets and tokens, never its
        // creator's own (docs/teams.md); passed only for a team's work.
        const runTeamId = task.ownerTeamId ?? null;
        const runTeam: [] | [string] = runTeamId ? [runTeamId] : [];
        const team = runTeamId ? { ownerTeamId: runTeamId } : {};
        const claudeAuthMode =
          ((await retrieveSecretWithFallback(
            "CLAUDE_AUTH_MODE",
            "global",
            taskWorkspaceId,
            runOwnerUserId,
            ...runTeam,
          ).catch(() => null)) as any) ?? "api-key";
        const codexAuthMode =
          ((await retrieveSecretWithFallback(
            "CODEX_AUTH_MODE",
            "global",
            taskWorkspaceId,
            runOwnerUserId,
            ...runTeam,
          ).catch(() => null)) as any) ?? "api-key";
        const codexAppServerUrl =
          codexAuthMode === "app-server"
            ? (((await retrieveSecretWithFallback(
                "CODEX_APP_SERVER_URL",
                "global",
                taskWorkspaceId,
                runOwnerUserId,
                ...runTeam,
              ).catch(() => null)) as any) ?? undefined)
            : undefined;
        const geminiAuthMode =
          ((await retrieveSecretWithFallback(
            "GEMINI_AUTH_MODE",
            "global",
            taskWorkspaceId,
            runOwnerUserId,
            ...runTeam,
          ).catch(() => null)) as any) ?? "api-key";

        // GCP config for Vertex AI — resolve per-agent so Claude's vertex config
        // does not bleed into Gemini tasks (and vice versa) when both are configured.
        const isClaudeVertex = task.agentType === "claude-code" && claudeAuthMode === "vertex-ai";
        const isGeminiVertex = task.agentType === "gemini" && geminiAuthMode === "vertex-ai";
        const needsGcpConfig = isClaudeVertex || isGeminiVertex;
        const googleCloudProject = needsGcpConfig
          ? (((await retrieveSecretWithFallback(
              isClaudeVertex ? "CLAUDE_VERTEX_PROJECT_ID" : "GOOGLE_CLOUD_PROJECT",
              "global",
              taskWorkspaceId,
              runOwnerUserId,
              ...runTeam,
            ).catch(() => null)) as any) ?? undefined)
          : undefined;
        const googleCloudLocation = needsGcpConfig
          ? (((await retrieveSecretWithFallback(
              isClaudeVertex ? "CLAUDE_VERTEX_REGION" : "GOOGLE_CLOUD_LOCATION",
              "global",
              taskWorkspaceId,
              runOwnerUserId,
              ...runTeam,
            ).catch(() => null)) as any) ?? undefined)
          : undefined;
        const claudeVertexServiceAccountKey = isClaudeVertex
          ? (((await retrieveSecretWithFallback(
              "CLAUDE_VERTEX_SERVICE_ACCOUNT_KEY",
              "global",
              taskWorkspaceId,
              runOwnerUserId,
              ...runTeam,
            ).catch(() => null)) as any) ?? undefined)
          : undefined;
        const opencodeDefaultBaseUrl =
          ((await retrieveSecretWithFallback(
            "OPENCODE_DEFAULT_BASE_URL",
            "global",
            taskWorkspaceId,
            runOwnerUserId,
            ...runTeam,
          ).catch(() => null)) as any) ?? undefined;
        const opencodeDefaultModel =
          ((await retrieveSecretWithFallback(
            "OPENCODE_DEFAULT_MODEL",
            "global",
            taskWorkspaceId,
            runOwnerUserId,
            ...runTeam,
          ).catch(() => null)) as any) ?? undefined;
        const optioApiUrl = `http://${process.env.API_HOST ?? "host.docker.internal"}:${process.env.API_PORT ?? "4000"}`;

        // Load and render prompt template
        const promptConfig = await getPromptTemplate(task.repoUrl);

        // repoConfig already loaded above for concurrency check

        const parsedRepo = parseRepoUrl(
          task.repoUrl,
          resolveRepoPlatform(task.repoUrl, repoConfig?.gitPlatform) ?? undefined,
        );
        const repoName = parsedRepo ? `${parsedRepo.owner}/${parsedRepo.repo}` : task.repoUrl;
        const isGitLab = parsedRepo?.platform === "gitlab";
        const isCodeCommit = parsedRepo?.platform === "codecommit";
        const branchName = `${TASK_BRANCH_PREFIX}${task.id}`;
        const taskFilePath = TASK_FILE_PATH;

        // Enable planning mode for fresh runs (not resumed) when repo has it enabled
        const isPlanningRun =
          !!repoConfig?.planningModeEnabled && !resumeSessionId && !reviewOverride;

        // Draft PRs when the repo or the task's own settings ask for them.
        const cautious = task.settings?.cautiousMode === true || !!promptConfig.cautiousMode;
        const trace = await workTraceability(task);
        const renderedPrompt = renderPromptTemplate(promptConfig.template, {
          TASK_FILE: taskFilePath,
          BRANCH_NAME: branchName,
          TASK_ID: task.id,
          TASK_TITLE: shellSafeTitle(task.title),
          REPO_NAME: repoName,
          // The task's own follow-through wins over the repo's; cautious mode
          // (draft PRs) never merges.
          AUTO_MERGE: String(cautious ? false : (task.autoMerge ?? promptConfig.autoMerge)),
          DRAFT_PR: String(cautious),
          ISSUE_NUMBER: task.ticketExternalId ?? "",
          GIT_PLATFORM_GITLAB: isGitLab ? "true" : "",
          GIT_PLATFORM_CODECOMMIT: isCodeCommit ? "true" : "",
          CODECOMMIT_REPO: isCodeCommit ? (parsedRepo?.repo ?? "") : "",
          BASE_BRANCH: task.repoBranch ?? repoConfig?.defaultBranch ?? "main",
          PLANNING_MODE: isPlanningRun ? "true" : "",
          ...trace.promptVars,
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
        // Per-run agent options (the New session form's Who parameters) win
        // over the repo's defaults; anything unset falls through as before.
        const agentOptions = ((task.metadata as any)?.agentOptions ?? {}) as Record<
          string,
          string | boolean | undefined
        >;
        const runOpt = (key: string): string | undefined => {
          const v = agentOptions[key];
          return typeof v === "string" && v !== "" ? v : undefined;
        };
        const opt = <K extends string>(key: K): string | undefined => {
          const v = runOpt(key);
          if (v) return v;
          const fromRepo = (repoConfig as Record<string, unknown> | null | undefined)?.[key];
          return typeof fromRepo === "string" ? fromRepo : undefined;
        };
        // Codex shares Copilot's copilotModel / copilotEffort, but a repo's
        // values there are Copilot's settings (Codex has none per repo): a
        // Codex run takes only its own.
        const copilotOpt = (key: string) => (task.agentType === "codex" ? runOpt(key) : opt(key));
        const finalClaudeModel = reviewOverride?.claudeModel ?? opt("claudeModel");
        // A model provider (Bedrock) picked for this run: checked against the
        // owner again here, since it may have been removed or changed since.
        const providerRow = reviewOverride
          ? null
          : await resolveProviderForWork({
              agentType: task.agentType,
              agentOptions,
              workspaceId: taskWorkspaceId,
              ownerUserId: runOwnerUserId,
              ...team,
              runsOn: "pod",
            });
        const providerRuntime = providerRow
          ? podProviderRuntime(providerRow, task.agentType)
          : null;
        if (providerRow) log.info({ provider: providerRow.name }, "Using model provider");

        const agentConfig = adapter.buildContainerConfig({
          taskId: task.id,
          prompt: task.prompt,
          repoUrl: task.repoUrl,
          repoBranch: task.repoBranch,
          claudeAuthMode: providerRuntime ? "bedrock" : claudeAuthMode,
          codexAuthMode: providerRuntime ? "bedrock" : codexAuthMode,
          codexAppServerUrl,
          modelProviderEnv: providerRuntime?.env,
          codexProviderConfig: providerRuntime?.codexConfig,
          optioApiUrl,
          renderedPrompt: finalRenderedPrompt,
          taskFileContent: finalTaskFileContent,
          taskFilePath: finalTaskFilePath,
          claudeModel: finalClaudeModel,
          claudeContextWindow: opt("claudeContextWindow"),
          claudeEffort: opt("claudeEffort"),
          copilotModel: copilotOpt("copilotModel"),
          copilotEffort: copilotOpt("copilotEffort"),
          opencodeModel: opt("opencodeModel") ?? opencodeDefaultModel,
          opencodeAgent: opt("opencodeAgent"),
          opencodeBaseUrl: opt("opencodeBaseUrl") ?? opencodeDefaultBaseUrl,
          cursorModel: opt("cursorModel"),
          piModel:
            reviewOverride?.model ??
            (task.agentType === "pi" ? reviewOverride?.claudeModel : undefined) ??
            opt("piModel"),
          piThinking: opt("piThinking"),
          geminiAuthMode,
          geminiModel: opt("geminiModel"),
          geminiApprovalMode:
            (opt("geminiApprovalMode") as "default" | "auto_edit" | "yolo" | undefined) ??
            undefined,
          maxTurnsCoding: repoConfig?.maxTurnsCoding ?? undefined,
          maxTurnsReview: repoConfig?.maxTurnsReview ?? undefined,
          googleCloudProject,
          googleCloudLocation,
          claudeVertexServiceAccountKey,
        });

        // ── The agent's environment: MCP servers, connections, skills, and
        // the work's own setup commands — the repo's defaults with the
        // task's settings applied (agent-environment-service).
        Object.assign(
          agentConfig.env,
          await buildAgentEnvironment(
            {
              repoUrl: task.repoUrl,
              agentType: task.agentType,
              workspaceId: taskWorkspaceId,
              ownerUserId: runOwnerUserId,
              ...team,
              settings: task.settings,
              runId: task.id,
              ...(task.taskType === "coding" ? { controllerRunKind: "work-run" as const } : {}),
            },
            log,
            agentConfig.setupFiles,
          ),
        );

        // Resolve secrets (workspace → repo-scoped → global fallback)
        // The repository platform decides which git token is required.
        const gitToken = requiredGitTokenSecret(parsedRepo?.platform);
        const secretNames = [
          ...new Set([...agentConfig.requiredSecrets, ...(gitToken ? [gitToken] : [])]),
        ];
        const resolvedSecrets = await resolveSecretsForTask(
          secretNames,
          task.repoUrl,
          taskWorkspaceId,
          runOwnerUserId,
          ...runTeam,
        );
        if (task.agentType === "pi") {
          const pickedCredential = await resolveCredentialForWork({
            agentType: task.agentType,
            agentOptions,
            workspaceId: taskWorkspaceId,
            ownerUserId: runOwnerUserId,
            ...team,
            runsOn: "pod",
          });
          Object.assign(
            resolvedSecrets,
            await piProviderSecrets(
              (name) =>
                resolveSecretsForTask(
                  [name],
                  task.repoUrl,
                  taskWorkspaceId,
                  runOwnerUserId,
                  ...runTeam,
                )
                  .then((values) => values[name])
                  .catch(() => null),
              pickedCredential ? credentialRuntime("pi", pickedCredential) : null,
            ),
          );
        }
        // The secrets this work picked for its pod (personal work: its owner's first).
        const picked = await resolvePodSecrets(task.podSecrets, {
          repoUrl: task.repoUrl,
          workspaceId: taskWorkspaceId,
          ownerUserId: runOwnerUserId,
          ...team,
        });
        if (picked.missing.length > 0) {
          log.warn({ missing: picked.missing }, "Picked pod secrets not found");
        }
        const allEnv: Record<string, string> = {
          ...picked.env,
          ...agentConfig.env,
          ...resolvedSecrets,
          // A connection's shell env (its AWS keys, say) is this work's own
          // choice, so it beats the deployment's secrets of the same name.
          ...(await connectionShellEnv({
            repoUrl: task.repoUrl,
            agentType: task.agentType,
            workspaceId: taskWorkspaceId,
            ownerUserId: runOwnerUserId,
            ...team,
            settings: task.settings,
          })),
        };
        Object.assign(allEnv, trace.env);

        // Git sign-in (platform tokens are infra-level, not adapter secrets).
        await applyGitAccess(allEnv, {
          workspaceId: taskWorkspaceId,
          ownerUserId: runOwnerUserId,
          ...team,
          repoUrl: task.repoUrl,
          runId: task.id,
        });

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
        if (task.agentType !== "pi" && claudeAuthMode === "max-subscription") {
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
        if (task.agentType !== "pi" && claudeAuthMode === "oauth-token") {
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
            runOwnerUserId,
            ...runTeam,
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

        // The pod's own env (repo-init.sh): no run's secrets — the pod is shared.
        const podEnv = await repoPool.repoPodEnv(allEnv, task.repoUrl, taskWorkspaceId);

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
            ownerUserId: runOwnerUserId,
            ...team,
            credentialProfile: workCredentialProfile(task),
            isolationPurpose: reviewOverride || task.taskType === "review" ? "review" : "work",
          },
        );
        repoPodId = pod.id;
        log.info({ podName: pod.podName, instanceIndex: pod.instanceIndex }, "Repo pod ready");

        await taskService.updateTaskContainer(taskId, pod.podName ?? pod.podId ?? pod.id);

        // ── Check for existing PR before launching agent ───────────────
        // If a previous run already opened a PR for this task's branch,
        // skip the agent entirely and transition straight to pr_opened.
        // This avoids wasting compute on tasks killed by restarts/reconcile.
        const isReviewTask0 = !!reviewOverride || task.taskType === "review";
        if (!restartFromBranch && !resumeSessionId && !isReviewTask0) {
          const existingPr = await checkExistingPr(task.repoUrl, taskId, taskWorkspaceId);
          if (existingPr) {
            log.info(
              { prUrl: existingPr.url, prNumber: existingPr.number },
              "Existing PR found — skipping agent, transitioning to pr_opened",
            );
            await taskService.updateTaskPr(taskId, existingPr.url);
            await repoPool.updateWorktreeState(taskId, "preserved");
            await taskService.transitionTask(taskId, TaskState.RUNNING, "worktree_created");
            await taskService.transitionTask(
              taskId,
              TaskState.PR_OPENED,
              "existing_pr_detected",
              existingPr.url,
            );
            return;
          }
        }

        // Build the agent command based on type. `pr_review` no longer
        // exists as a tasks.taskType — external PR reviews run under
        // pr_review_runs via pr-review-worker.ts.
        const isReviewTask = !!reviewOverride || task.taskType === "review";
        const agentCommand = buildAgentCommand(task.agentType, allEnv, {
          resumeSessionId,
          resumePrompt,
          isReview: isReviewTask,
          maxTurnsCoding: repoConfig?.maxTurnsCoding ?? undefined,
          maxTurnsReview: repoConfig?.maxTurnsReview ?? undefined,
        });

        // Start the agent under the run protocol (docs/plans/scale-out.md §1):
        // the start exec sets the worktree up and returns once the supervisor
        // runs; from then on any API instance can attach to the run's output,
        // and this one does so right away. The task stays `provisioning`
        // until the start is recorded, so `running` always means an agent
        // some instance can attach to.
        // On retry to the same pod, reset existing worktree instead of recreating
        const shouldResetWorktree = isRetry && pod.id === (task as any).lastPodId;
        const runStartedAt = new Date();
        log.info("Starting agent in worktree");
        startAttempted = true;
        const started = await repoPool.startTaskInRepoPod(pod, task.id, agentCommand, allEnv, {
          resetWorktree: shouldResetWorktree,
          // Claude runs with `--input-format stream-json`: the first user
          // message arrives over stdin, which the start script primes from
          // this before the agent launches.
          initialStdin:
            task.agentType === "claude-code"
              ? buildInitialClaudeStreamMessage(allEnv.OPTIO_PROMPT ?? "")
              : "",
        });
        slotHeld = true;
        if (started.output.trim()) {
          log.debug({ setup: started.output.slice(-2000) }, "Run setup output");
        }
        await rememberRunContext(taskId, { isReviewTask, isPlanningRun, runStartedAt });
        if (!(await recordRunStarted(hold, { podId: pod.id, pid: started.pid }))) {
          // Queued again while it was set up (a force-redo): the agent is
          // nobody's, and `endRunJob` stops it.
          log.info("The task moved on while its agent started; stopping the agent");
          return;
        }
        // Cancelled or reset while it was set up: the transition throws, and
        // `endRunJob` stops the agent nobody will stream.
        await taskService.transitionTask(taskId, TaskState.RUNNING, "worktree_created");
        log.info({ pid: started.pid }, "Agent started; attaching");

        ended = await finishTaskRun({
          taskId,
          task,
          log,
          pod: { id: pod.id, handle: podPool.podHandle(pod) },
          isReviewTask,
          isPlanningRun,
          runStartedAt,
          hold,
          claim: { consumedBytes: 0, execState: "started", pid: started.pid },
        });
      } catch (err) {
        // State race errors mean another worker claimed the task — not a real failure
        if (err instanceof taskService.StateRaceError) {
          log.info({ err: String(err) }, "Lost state race, skipping");
          return;
        }
        // Once its agent streams, an error is this instance's trouble, not
        // the run's: the run is left for an attach (run-attachment.ts).
        const afterStart = await onStreamError(hold, log);
        if (afterStart) {
          ended = afterStart;
          log.error({ err }, "Task worker error while streaming; the run is left for an attach");
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
            if (currentTask.state === "provisioning" && !startAttempted) {
              const MAX_PROVISIONING_RETRIES = 3;
              const errStr = describeError(err);
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
            await taskService.updateTaskResult(taskId, undefined, describeError(err));
            await taskService.transitionTask(
              taskId,
              TaskState.FAILED,
              "worker_error",
              describeError(err),
            );
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
        // Let go of the run: an agent this job started and left behind is
        // stopped first, then the lease goes (run-attachment.ts).
        await endRunJob(hold, ended, log);
        // Release the task slot on the repo pod — unless the run goes on
        // without this job (whoever finishes it gives the slot back).
        if (repoPodId && slotHeld && ended !== "detached") {
          await repoPool.releaseRepoPodTask(repoPodId).catch(() => {});
        }
      }
    }),
    {
      ...bullmqOpts,
      concurrency: parseIntEnv("OPTIO_MAX_CONCURRENT", 5),
      // A job lasts as long as this instance streams the run. Recovery no
      // longer rides on BullMQ's stall re-delivery (the attach sweep and the
      // reconciler re-attach a run whose instance died), so the lock is
      // short: a stale re-delivery is a no-op (the run is not queued, or
      // its attachment is held).
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 3,
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

// ── The run protocol: attaching to a task's agent and finishing the run ──────

/** The attachment columns of a task row (run-attachment.ts). */
export function taskRef(taskId: string): AttachRef {
  return { kind: "work-run", id: taskId };
}

/**
 * What finishing a run needs that only the starting job knew: kept on the
 * task row (`metadata.run`) so an instance that attaches later finishes the
 * run the same way.
 */
interface TaskRunContext {
  isReviewTask: boolean;
  isPlanningRun: boolean;
  runStartedAt: Date;
}

async function rememberRunContext(taskId: string, ctx: TaskRunContext): Promise<void> {
  const patch = JSON.stringify({
    run: {
      isReviewTask: ctx.isReviewTask,
      isPlanningRun: ctx.isPlanningRun,
      runStartedAt: ctx.runStartedAt.toISOString(),
    },
  });
  await db
    .update(tasks)
    .set({ metadata: sql`COALESCE(${tasks.metadata}, '{}'::jsonb) || ${patch}::jsonb` })
    .where(eq(tasks.id, taskId));
}

function recallRunContext(task: typeof tasks.$inferSelect): TaskRunContext {
  const run = ((task.metadata as Record<string, unknown> | null)?.run ?? {}) as {
    isReviewTask?: boolean;
    isPlanningRun?: boolean;
    runStartedAt?: string;
  };
  return {
    isReviewTask: run.isReviewTask ?? task.taskType === "review",
    isPlanningRun: run.isPlanningRun ?? false,
    runStartedAt: run.runStartedAt
      ? new Date(run.runStartedAt)
      : (task.startedAt ?? task.createdAt ?? new Date()),
  };
}

interface FinishTaskRunInput extends TaskRunContext {
  taskId: string;
  task: typeof tasks.$inferSelect;
  log: typeof logger;
  pod: AttachedPod;
  hold: AttachmentHold;
  /** Where the run's log rows reach, and whether an earlier holder already recorded its exit. */
  claim: AttachmentClaim;
}

/**
 * Streams a started run to its end and settles the task — the one path for
 * the job that started the run and for a job that attaches to it later.
 * Returns "detached" when this instance stopped streaming without the run
 * ending (shutdown, or another instance took the run): the task is left as
 * it is for whoever attaches next.
 */
async function finishTaskRun(input: FinishTaskRunInput): Promise<RunEnd> {
  const { taskId, task, log, pod, isReviewTask, isPlanningRun, runStartedAt, hold } = input;
  const taskWorkspaceId = task.workspaceId ?? null;
  const ref = taskRef(taskId);
  const runtime = getRuntime();
  const runDir = runHome(taskId).podDir;
  const parseEvent = getEventParser(task.agentType);

  // Derivations: rebuilt from byte 0 on every attach, never persisted.
  // PRs the agent's own PR-creating tool calls produced (`gh pr create`, MCP
  // `create_pull_request`, …), each paired with its call's result by id. A
  // PR URL the agent merely mentions is never adopted.
  const prTracker = new PrToolCallTracker();
  const digest = new RunOutputDigest(task.agentType);
  let lastHeartbeat = Date.now();
  const HEARTBEAT_INTERVAL_MS = 60_000;
  // Stall detection: debounced activity timestamp flush
  const activity = activityFlusher((at) => taskService.updateTaskActivity(taskId, at), 5_000);

  const { outcome, sessionId } = await streamRun({
    runtime,
    handle: pod.handle,
    ref,
    runDir,
    hold,
    consumedBytes: input.claim.consumedBytes,
    log,
    parse: (line) => parseEvent(line, taskId),
    derive(line) {
      digest.push(line);
      if (!isReviewTask) ingestPrToolCallLine(prTracker, task.agentType, line);
    },
    async onSession(id) {
      await taskService.updateTaskSession(taskId, id);
      log.info({ sessionId: id }, "Session ID captured");
    },
    onEntries(entries) {
      for (const entry of entries) activity.mark(entry.type);
    },
    publish: (row) => taskService.publishTaskLogRow(taskId, row),
    async onChunk() {
      // Periodically bump tasks.updatedAt so the stale detector knows this
      // task is still actively streaming
      const now = Date.now();
      if (now - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
        await taskService.touchTaskHeartbeat(taskId);
        lastHeartbeat = now;
      }
      // Debounced flush of lastActivityAt to avoid per-event DB writes
      await activity.maybeFlush();
    },
  });
  // Final flush of pending activity timestamp
  await activity.flush();

  if (outcome.kind === "reset") {
    log.info("The task was queued again while its agent ran; leaving this attempt");
    return "reset";
  }
  if (outcome.kind === "taken" || outcome.kind === "detached") {
    log.info({ outcome: outcome.kind }, "Detached from the run; it continues in its pod");
    return "detached";
  }

  if (outcome.kind === "lost") {
    // The supervisor and its files are gone without an exit: the pod
    // restarted under the run. Nothing can say what the agent did.
    const stderrTail = await readRunStderr(runtime, pod.handle, runDir);
    const settledLost = await settleRun(hold);
    if (settledLost === "taken" || settledLost === "reset") return endOfLoss(settledLost);
    await failLostTask(
      taskId,
      "The agent's process and its output are gone (the pod restarted while it ran)",
      stderrTail,
    );
    await closeAttachment(hold);
    log.warn("Run lost: the pod restarted under the agent");
    return "finished";
  }

  // The agent exited and every line of its output is a log row. What the
  // output says (read as it streamed): the result, with the exit code the
  // output implies (agent-type-specific patterns) over the real status.
  const verdict = digest.finish(outcome.code, { inferExitCode: true });
  const result = verdict.result;

  // Override a nominally-successful result if the agent emitted an auth
  // failure mid-run. Many agent CLIs catch 401s internally and exit 0,
  // which would otherwise mark the task as completed despite no useful
  // work. Mutating the result here propagates to every downstream branch.
  const authDetection = verdict.auth;
  if (authDetection.matched && result.success) {
    log.warn(
      { pattern: authDetection.pattern, excerpt: authDetection.excerpt },
      "Auth failure detected in agent output — overriding result",
    );
    result.success = false;
    result.error = `Agent authentication failed: ${authDetection.excerpt ?? authDetection.pattern}`;
    recordAuthEvent(
      "claude",
      authDetection.excerpt ?? authDetection.pattern ?? "auth_failure",
      "task-worker",
    ).catch(() => {});
  }

  // A run that failed or produced nothing says why in its stderr, which the
  // failure message carries (the run directory goes once the run is over).
  const noOutput = !sessionId && !isReviewTask;
  const stderrTail =
    !result.success || noOutput ? await readRunStderr(runtime, pod.handle, runDir) : "";
  if (!result.success && stderrTail) {
    result.error = withStderr(result.error ?? "Agent failed", stderrTail);
  }

  // Record the exit with this run's cost, token usage, and model, ADDED to
  // what the task already recorded — once, whichever instance gets here
  // (`settleRun` is a CAS on the exit). Each launch — a first run, a retry
  // (issue #580: a failed attempt's tokens were still spent), a resume or
  // force-restart (issue #541: `claude --resume` reports only its own
  // turns) — is a distinct process reporting only its own spend, so prior +
  // this run is always the true total. Postgres does the addition.
  const settled = await settleRun(hold, {
    ...addUsage(workRuns, result),
    resultSummary: result.summary,
    ...(result.error !== undefined ? { errorMessage: result.error } : {}),
    updatedAt: new Date(),
  });
  if (settled === "taken" || settled === "reset") return endOfLoss(settled);

  // Before processing results, verify this worker still owns the task.
  // A force-redo may have reset the task while we were streaming.
  const taskAfterExec = await taskService.getTask(taskId);
  if (!taskAfterExec || taskAfterExec.state !== TaskState.RUNNING) {
    log.info(
      { currentState: taskAfterExec?.state },
      "Task state changed during execution — skipping final transition (likely force-redo)",
    );
    await closeAttachment(hold);
    return "finished";
  }

  // ── Telemetry: record cost and token metrics (once, with the spend) ──
  if (settled === "settled") {
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
  }
  // Which PRs did this run open? Only the agent's own PR-creating tool
  // calls (URL from that call's result) and PRs whose head branch is
  // under the task's branch count — each confirmed against the git
  // platform. A URL the agent merely mentions is never adopted. Every
  // PR is recorded in task_prs; the first becomes tasks.pr_url (the
  // primary the PR lifecycle follows), unless the task already has one
  // (a resumed / restarted run keeps its PR).
  let detectedPrUrl: string | undefined = taskAfterExec?.prUrl ?? undefined;
  // Set when the platform answered the branch lookup and found nothing —
  // lets the later API-fallback checks skip a redundant call.
  let prKnownAbsent = false;
  if (!isReviewTask) {
    try {
      const branches = await repoPool.listTaskBranchesInPod(pod.id, taskId);
      const detection = await detectTaskPrs(
        { id: taskId, repoUrl: task.repoUrl },
        { matches: prTracker.matches, runStartedAt, branches },
      );
      detectedPrUrl = detection.primaryUrl ?? detectedPrUrl;
      prKnownAbsent = detection.platformChecked && !detection.primaryUrl;
      if (
        prTracker.matches.length > detection.adopted.filter((p) => p.source === "tool_call").length
      ) {
        log.info(
          { created: prTracker.matches.map((m) => m.url ?? m.codecommit) },
          "Some PRs from the agent's create calls were not adopted (other repo, closed, or unconfirmed)",
        );
      }
    } catch (err) {
      log.warn({ err }, "PR detection failed");
    }
  }

  const outcomeKind = classifyRunOutcome({
    success: result.success,
    isReviewTask,
    sessionId,
    detectedPrUrl,
  });

  if (outcomeKind === "no_output") {
    // Agent never started — no session ID means no agent output was produced.
    await repoPool.updateWorktreeState(taskId, "dirty");
    await taskService.transitionTask(
      taskId,
      TaskState.FAILED,
      "agent_no_output",
      withStderr("Agent process exited without producing any output", stderrTail),
    );
    log.warn("Agent exited without output — no session ID captured");
  } else if (outcomeKind === "pr_opened" && detectedPrUrl) {
    // PR exists — go to pr_opened regardless of exit code.
    if (detectedPrUrl !== taskAfterExec?.prUrl) {
      await taskService.updateTaskPr(taskId, detectedPrUrl);
    }
    // Preserve worktree for resume (pr_opened state needs it)
    await repoPool.updateWorktreeState(taskId, "preserved");
    await taskService.transitionTask(taskId, TaskState.PR_OPENED, "pr_detected", detectedPrUrl);
    log.info({ prUrl: detectedPrUrl }, "PR opened");
  } else if (outcomeKind === "success") {
    // External PR reviews no longer run here — they execute under
    // pr_review_runs via pr-review-worker.ts. Subtask reviews
    // (`taskType === "review"`) still flow through this path and
    // their result lands in the parent coding task's comments.
    // Failed review runs (e.g. terminal API errors, issue #552) take the
    // failure branch below like any other run — they must not be marked
    // completed, which would both show a false green state and count as
    // an approval for auto-merge in subtask-service.

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
    } else if (
      shouldEscalateNoPr({
        success: result.success,
        isReviewTask,
        isPlanningRun,
        hasRepoUrl: !!task.repoUrl,
        detectedPrUrl,
      })
    ) {
      // Repo Task completed without opening a PR. Before escalating,
      // check the API as a fallback — the agent may have pushed a PR
      // that wasn't captured in log output.
      let apiFallbackPr: ExistingPr | null = null;
      if (!prKnownAbsent) {
        try {
          apiFallbackPr = await checkExistingPr(task.repoUrl, taskId, taskWorkspaceId);
        } catch {
          // Non-fatal — proceed with escalation
        }
      }

      if (apiFallbackPr) {
        await taskService.updateTaskPr(taskId, apiFallbackPr.url);
        await repoPool.updateWorktreeState(taskId, "preserved");
        await taskService.transitionTask(
          taskId,
          TaskState.PR_OPENED,
          "pr_detected_api",
          apiFallbackPr.url,
        );
        log.info(
          { prUrl: apiFallbackPr.url },
          "PR found via API fallback after successful agent exit",
        );
      } else {
        await repoPool.updateWorktreeState(taskId, "preserved");
        await taskService.transitionTask(
          taskId,
          TaskState.NEEDS_ATTENTION,
          "completed_without_pr",
          "Agent completed successfully but did not open a pull request. " +
            "The work may need to be committed and pushed manually, or the agent can be restarted to open a PR.",
        );
        log.warn("Repo Task completed without opening a PR — escalating to needs_attention");
      }
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
    if (!isReviewTask && !prKnownAbsent) {
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
      await taskService.transitionTask(taskId, TaskState.FAILED, "agent_failure", result.error);
      log.warn({ error: result.error }, "Task failed");

      // Publish global alert for auth failures so the UI can show a banner
      if (result.error && /OAuth token|authentication_failed|token.*expired/i.test(result.error)) {
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

  // The run is over and every byte of its output is a log row: its
  // directory in the pod (output, stdin, the runtime's config) goes.
  await removeRunDirectory(runtime, pod.handle, runDir, log);
  await closeAttachment(hold);

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
  return "finished";
}

/** Fails a task whose agent is gone with its pod (the pod-death path), workspace kept. */
async function failLostTask(taskId: string, detail: string, stderrTail = ""): Promise<void> {
  const message = withStderr(
    `${detail}. Workspace retained where it survived; inspect before retrying.`,
    stderrTail,
  );
  await repoPool.updateWorktreeState(taskId, "preserved").catch(() => {});
  await taskService.updateTaskResult(taskId, undefined, message);
  await taskService.transitionTask(taskId, TaskState.FAILED, "run_lost", message);
}

/**
 * An `attach-task` job (the reconciler's `reattach` action): take the run
 * if nobody holds it and finish it from where its log rows stop. Losing
 * the claim is the normal case when two instances answer the same sweep.
 */
async function attachTask(job: { id?: string; data: unknown }): Promise<void> {
  const { taskId } = job.data as { taskId: string };
  const log = logger.child({ taskId, jobId: job.id, attach: true });
  const task = await taskService.getTask(taskId);
  if (
    !task ||
    (task.state !== TaskState.RUNNING && task.state !== TaskState.PROVISIONING) ||
    task.runTarget === "local"
  ) {
    log.info({ state: task?.state }, "Skipping attach — the task is not an active pod run");
    return;
  }
  try {
    await runAttachJob({
      ref: taskRef(taskId),
      log,
      podId: task.lastPodId ?? null,
      async onPodGone(detail) {
        if (task.state === TaskState.PROVISIONING) {
          await taskService.transitionTask(taskId, TaskState.RUNNING, "run_reattached");
        }
        await failLostTask(taskId, detail);
      },
      async finish(pod, hold, claim) {
        // The instance that started the agent went away before recording
        // `running`: the run is this instance's now.
        if (task.state === TaskState.PROVISIONING) {
          await taskService.transitionTask(taskId, TaskState.RUNNING, "run_reattached");
        }
        return finishTaskRun({
          taskId,
          task,
          log,
          pod,
          ...recallRunContext(task),
          hold,
          claim,
        });
      },
      async onAttachFailed(message) {
        const current = await taskService.getTask(taskId);
        if (current?.state === TaskState.PROVISIONING) {
          await taskService.transitionTask(taskId, TaskState.RUNNING, "run_reattached");
        }
        await repoPool.updateWorktreeState(taskId, "dirty").catch(() => {});
        await taskService.updateTaskResult(taskId, undefined, message);
        await taskService.transitionTask(taskId, TaskState.FAILED, "attach_failed", message);
      },
      afterFinish: async (podId) => {
        if (podId) await repoPool.releaseRepoPodTask(podId);
      },
    });
  } catch (err) {
    if (err instanceof taskService.StateRaceError) {
      log.info({ err: String(err) }, "Lost state race while attached, skipping");
      return;
    }
    log.error({ err }, "Attach failed; the run stays for the next attach");
    throw err;
  }
}

/**
 * Re-enqueue orphaned tasks on startup.
 * After a Redis restart, BullMQ jobs are lost but tasks remain in
 * "queued" state in the database. This function detects those orphans and
 * re-adds them to the queue.
 *
 * Runs in flight are not touched: their agents keep going in their pods
 * under the run protocol, and the attach sweep and the reconciler re-attach
 * them to whichever instance is up (docs/plans/scale-out.md §2). A boot
 * fails nothing.
 */
export async function reconcileOrphanedTasks() {
  // Do not obliterate the queue: queued jobs may be durable, and a restart
  // is not authorization to repeat an execution with an uncertain outcome.
  // Only work that has not started is eligible to be re-enqueued.
  const toEnqueue = await db
    .select()
    .from(tasks)
    .where(eq(tasks.state, "queued" as any));

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

  // Reset each repo pod's active count to match actual running tasks.
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
/**
 * Feed one line of agent output to the PR tool-call tracker. Codex speaks
 * `exec --json`; Claude Code (and the agents that mirror its stream-json)
 * speak stream-json. Other formats simply yield nothing, leaving the
 * branch lookup to find their PRs.
 */
export function ingestPrToolCallLine(
  tracker: PrToolCallTracker,
  agentType: string,
  line: string,
): void {
  if (agentType === "codex") tracker.ingestCodexLine(line);
  else tracker.ingestClaudeLine(line);
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
              `if curl -sf ${shellQuote(`${env.OPTIO_API_URL}/api/auth/claude-token`)} > /dev/null 2>&1; then echo "[optio] Token proxy OK"; fi`,
              `unset ANTHROPIC_API_KEY 2>/dev/null || true`,
            ]
          : [];

      const resumeFlag = opts?.resumeSessionId
        ? `--resume ${shellQuote(opts.resumeSessionId)}`
        : "";

      // Build --model flag from env vars set by the adapter
      const modelName = env.OPTIO_CLAUDE_MODEL;
      const ctxWindow = env.OPTIO_CLAUDE_CONTEXT_WINDOW;
      let modelFlag = "";
      if (modelName) {
        const ctx = ctxWindow === "1m" ? "[1m]" : "";
        modelFlag = `--model ${shellQuote(`${modelName}${ctx}`)}`;
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
          ? ` --app-server ${shellQuote(env.OPTIO_CODEX_APP_SERVER_URL)}`
          : "";
      return [
        `echo "[optio] Running OpenAI Codex${appServerFlag ? " (app-server)" : ""}..."`,
        ...EXPORT_CODEX_HOME,
        // The pod is the sandbox; `--full-auto` is gone from recent Codex
        // releases. Codex reads a non-TTY stdin to EOF before its first model
        // call, and the run's stdin stays open for messages: give it none.
        `codex exec --dangerously-bypass-approvals-and-sandbox${codexModelFlags(env)} "$OPTIO_PROMPT"${appServerFlag} --json </dev/null`,
      ];
    }
    case "copilot": {
      const modelFlag = env.COPILOT_MODEL ? ` --model ${shellQuote(env.COPILOT_MODEL)}` : "";
      const effortFlag = env.COPILOT_EFFORT ? ` --effort ${shellQuote(env.COPILOT_EFFORT)}` : "";
      return [
        `echo "[optio] Running GitHub Copilot..."`,
        `copilot --autopilot --yolo --max-autopilot-continues ${maxTurns} \\`,
        `  --output-format json --no-ask-user${modelFlag}${effortFlag}${copilotMcpConfigFlag(env)} \\`,
        `  -p "$OPTIO_PROMPT"`,
      ];
    }
    case "opencode": {
      const modelFlag = env.OPTIO_OPENCODE_MODEL
        ? ` --model ${shellQuote(env.OPTIO_OPENCODE_MODEL)}`
        : "";
      const agentFlag = env.OPTIO_OPENCODE_AGENT
        ? ` --agent ${shellQuote(env.OPTIO_OPENCODE_AGENT)}`
        : "";
      const resumeFlag = opts?.resumeSessionId
        ? ` --session ${shellQuote(opts.resumeSessionId)}`
        : "";
      const autoApprove = opencodeHeadlessEnabled() ? ` ${OPENCODE_AUTO_APPROVE_FLAG}` : "";
      // `opencode run` reads stdin to EOF before it starts whenever stdin is
      // not a TTY; the pod exec hands it a pipe that never closes.
      return [
        `echo "[optio] Running OpenCode (experimental)..."`,
        ...EXPORT_OPENCODE_CONFIG,
        // With the headless rules on, approve what no rule denies, so a
        // headless ask never aborts (#585).
        `opencode run --format json${autoApprove}${modelFlag}${agentFlag}${resumeFlag} "$OPTIO_PROMPT" </dev/null`,
      ];
    }
    case "gemini": {
      const geminiModelFlag = env.OPTIO_GEMINI_MODEL
        ? ` -m ${shellQuote(env.OPTIO_GEMINI_MODEL)}`
        : "";
      return [
        `echo "[optio] Running Gemini..."`,
        ...EXPORT_GEMINI_HOME,
        `gemini -p "$OPTIO_PROMPT" \\`,
        `  --output-format stream-json \\`,
        `  --approval-mode yolo${geminiModelFlag}`,
      ];
    }
    case "openclaw": {
      const openclawModelFlag = env.OPTIO_OPENCLAW_MODEL
        ? ` --model ${shellQuote(env.OPTIO_OPENCLAW_MODEL)}`
        : "";
      const openclawAgentFlag = env.OPTIO_OPENCLAW_AGENT
        ? ` --agent ${shellQuote(env.OPTIO_OPENCLAW_AGENT)}`
        : "";
      return [
        `echo "[optio] Running OpenClaw (experimental)..."`,
        `openclaw agent --output-format stream-json${openclawModelFlag}${openclawAgentFlag} "$OPTIO_PROMPT"`,
      ];
    }
    case "pi":
      return piCommand(env, opts?.resumeSessionId, true);
    case "cursor": {
      const cursorModelFlag = env.OPTIO_CURSOR_MODEL
        ? ` --model ${shellQuote(env.OPTIO_CURSOR_MODEL)}`
        : "";
      // --resume takes the chat id from the prior run's system:init event
      const cursorResumeFlag = opts?.resumeSessionId
        ? ` --resume ${shellQuote(opts.resumeSessionId)}`
        : "";
      // --approve-mcps: the run's MCP servers (.cursor/mcp.json) load without
      // the approval prompt a headless run could never answer.
      return [
        `echo "[optio] Running Cursor${opts?.isReview ? " (review)" : ""}..."`,
        `cursor-agent --print --trust --force --approve-mcps \\`,
        `  --output-format stream-json${cursorModelFlag}${cursorResumeFlag} "$OPTIO_PROMPT"`,
      ];
    }
    default:
      return [`echo "Unknown agent type: ${agentType}" && exit 1`];
  }
}

/**
 * Determines whether a Repo Task that completed successfully should be
 * escalated to needs_attention because no PR was opened.
 *
 * Repo Tasks are expected to produce a PR. If the agent exits cleanly without
 * opening one, the work didn't ship — the user should be notified so they can
 * resume or restart the agent.
 */
/**
 * Classify how a finished agent run should be handled.
 *
 * - "no_output"  — agent produced no session/output at all (non-review only)
 * - "pr_opened"  — a PR was detected (non-review only; reviews never own a PR)
 * - "success"    — agent finished successfully
 * - "failure"    — agent failed; applies to review subtasks too. A review run
 *   that ends in a terminal agent error (e.g. "API Error: Usage credits
 *   required", issue #552) must be failed — previously reviews unconditionally
 *   completed, hiding the error behind a green state and counting as an
 *   approval for auto-merge.
 */
export function classifyRunOutcome(opts: {
  success: boolean;
  isReviewTask: boolean;
  sessionId: string | undefined;
  detectedPrUrl: string | undefined | null;
}): "no_output" | "pr_opened" | "success" | "failure" {
  if (!opts.sessionId && !opts.isReviewTask) return "no_output";
  if (opts.detectedPrUrl && !opts.isReviewTask) return "pr_opened";
  return opts.success ? "success" : "failure";
}

export function shouldEscalateNoPr(opts: {
  success: boolean;
  isReviewTask: boolean;
  isPlanningRun: boolean;
  hasRepoUrl: boolean;
  detectedPrUrl: string | undefined | null;
}): boolean {
  if (!opts.success) return false;
  if (opts.isReviewTask) return false;
  if (opts.isPlanningRun) return false;
  if (!opts.hasRepoUrl) return false;
  if (opts.detectedPrUrl) return false;
  return true;
}

/** Infer exit code from agent logs based on agent-specific error patterns */
export { inferExitCode } from "../services/run-output-digest.js";
