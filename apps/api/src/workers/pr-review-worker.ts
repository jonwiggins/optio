/**
 * PR Review worker — executes pr_review_runs on repo-pod infrastructure.
 *
 * Each job corresponds to one pr_review_runs row. The worker claims the
 * run (queued → provisioning), provisions or reuses a repo pod, runs
 * the agent under an isolated worktree, streams logs into task_logs
 * (keyed by pr_review_run_id), and transitions the run + parent review
 * state when the agent exits.
 *
 * This is a sibling of task-worker.ts but does NOT touch the tasks table.
 * The shared primitives it depends on are:
 *   - repoPool.getOrCreateRepoPod
 *   - repoPool.execTaskInRepoPod (accepts any stable id for worktree keying)
 *   - agent-adapters (buildContainerConfig, parseResult)
 *   - the shared agent-event parsers
 *   - buildAgentCommand / buildInitialClaudeStreamMessage / inferExitCode
 *     exported from task-worker.ts
 */
import { Queue, Worker } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import {
  parseIntEnv,
  parseRepoUrl,
  PrReviewRunState,
  PrReviewState,
  DEFAULT_STALL_THRESHOLD_MS,
  type PresetImageId,
  describeError,
} from "@optio/shared";
import { getAdapter } from "@optio/agent-adapters";
import { db } from "../db/client.js";
import { prReviews, prReviewRuns } from "../db/schema.js";
import { insertLog } from "../services/run-log-service.js";
import { addUsage } from "../services/run-usage.js";
import { getEventParser } from "../services/event-parsers.js";
import * as repoPool from "../services/repo-pool-service.js";
import { resolveSecretsForTask, retrieveSecretWithFallback } from "../services/secret-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";
import { publishEvent } from "../services/event-bus.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";
import { logger } from "../logger.js";
import * as prReviewService from "../services/pr-review-service.js";
import { enqueueReconcile } from "../services/reconcile-queue.js";
import { resolveReviewConfig } from "../services/review-config.js";
import * as optioSettingsService from "../services/optio-settings-service.js";
import { buildAgentEnvironment } from "../services/agent-environment-service.js";
import { applyGitAccess } from "../services/git-access-env.js";
import { buildInitialClaudeStreamMessage } from "../services/pooled-agent-command.js";
import { buildAgentCommand, inferExitCode } from "./task-worker.js";

const bullmqOpts = getBullMQOptions();

export const prReviewRunQueue = new Queue("pr-review-runs", { ...bullmqOpts });

// ── Log helpers (writes to task_logs keyed by pr_review_run_id) ────────────

/** Exported for tests. */
export async function appendRunLog(
  run: typeof prReviewRuns.$inferSelect,
  content: string,
  stream: "stdout" | "stderr" = "stdout",
  logType?: string,
  metadata?: Record<string, unknown>,
) {
  const row = await insertLog({ prReviewRunId: run.id }, { content, stream, logType, metadata });
  await publishEvent({
    type: "pr_review_run:log",
    prReviewId: run.prReviewId,
    runId: run.id,
    stream,
    content,
    // The stored row's timestamp, not this process's clock, so the live
    // frame matches the same row in the catch-up / REST history.
    timestamp: row.timestamp.toISOString(),
    logType,
    metadata,
  });
}

// ── Run state transitions ──────────────────────────────────────────────────

async function transitionRun(
  runId: string,
  to: PrReviewRunState,
  patch?: Partial<typeof prReviewRuns.$inferSelect>,
): Promise<typeof prReviewRuns.$inferSelect | null> {
  const updates: Record<string, unknown> = {
    state: to,
    updatedAt: new Date(),
    ...(patch ?? {}),
  };
  if (to === PrReviewRunState.RUNNING && !patch?.startedAt) updates.startedAt = new Date();
  if (
    (to === PrReviewRunState.COMPLETED ||
      to === PrReviewRunState.FAILED ||
      to === PrReviewRunState.CANCELLED) &&
    !patch?.completedAt
  ) {
    updates.completedAt = new Date();
  }

  const [before] = await db.select().from(prReviewRuns).where(eq(prReviewRuns.id, runId));
  const [updated] = await db
    .update(prReviewRuns)
    .set(updates)
    .where(eq(prReviewRuns.id, runId))
    .returning();
  if (!updated) return null;

  await publishEvent({
    type: "pr_review_run:state_changed",
    prReviewId: updated.prReviewId,
    runId,
    fromState: (before?.state as PrReviewRunState) ?? null,
    toState: to,
    timestamp: new Date().toISOString(),
  });

  return updated;
}

// ── Worker ─────────────────────────────────────────────────────────────────

export function startPrReviewWorker() {
  const worker = new Worker(
    "pr-review-runs",
    instrumentWorkerProcessor("pr-review-worker", async (job) => {
      const { runId } = job.data as { runId: string };
      const log = logger.child({ runId, jobId: job.id });

      // Fetch the run + parent review.
      const [run] = await db.select().from(prReviewRuns).where(eq(prReviewRuns.id, runId));
      if (!run) {
        log.warn("PR review run not found; dropping job");
        return;
      }
      if (run.state !== PrReviewRunState.QUEUED) {
        log.info({ state: run.state }, "Skipping — run is not queued");
        return;
      }

      const [review] = await db.select().from(prReviews).where(eq(prReviews.id, run.prReviewId));
      if (!review) {
        log.warn("Parent pr_review row missing; failing run");
        await transitionRun(runId, PrReviewRunState.FAILED, {
          errorMessage: "Parent pr_review row disappeared",
        });
        return;
      }

      // If the parent got cancelled while we were in the queue, abort.
      if (review.state === PrReviewState.CANCELLED || review.state === PrReviewState.SUBMITTED) {
        await transitionRun(runId, PrReviewRunState.CANCELLED, {
          errorMessage: `Parent review is ${review.state}`,
        });
        return;
      }

      // Claim: queued → provisioning (idempotent). Use the same CAS idiom
      // as task-worker to guard against duplicate workers grabbing the job.
      const claimResult = await db
        .update(prReviewRuns)
        .set({ state: PrReviewRunState.PROVISIONING, updatedAt: new Date() })
        .where(and(eq(prReviewRuns.id, runId), eq(prReviewRuns.state, PrReviewRunState.QUEUED)))
        .returning({ id: prReviewRuns.id });
      if (claimResult.length === 0) {
        log.info("Claim failed — another worker grabbed this run");
        return;
      }
      await publishEvent({
        type: "pr_review_run:state_changed",
        prReviewId: run.prReviewId,
        runId,
        fromState: PrReviewRunState.QUEUED,
        toState: PrReviewRunState.PROVISIONING,
        timestamp: new Date().toISOString(),
      });

      let repoPodId: string | null = null;
      try {
        const { getRepoByUrl } = await import("../services/repo-service.js");
        const repoConfig = await getRepoByUrl(review.repoUrl, review.workspaceId ?? undefined);
        if (!repoConfig) throw new Error(`Repo ${review.repoUrl} is not configured in Optio`);

        const metadata =
          (run.metadata as {
            taskFileContent?: string;
            taskFilePath?: string;
            // Newer field — agent-agnostic. Supersedes claudeModel.
            model?: string;
            // Legacy field — left in place for one release while in-flight
            // jobs queued before the agent-aware review change drain.
            claudeModel?: string;
          } | null) ?? {};

        const renderedPrompt = run.prompt ?? "";
        const taskFileContent = metadata.taskFileContent ?? "";
        const taskFilePath = metadata.taskFilePath ?? ".optio/review-context.md";

        // ── Secret resolution ──────────────────────────────────────
        const workspaceId = review.workspaceId ?? null;
        const userId = review.createdBy ?? null;

        // Resolve agent + model via the shared resolver so the two review
        // entrypoints stay in sync. Metadata.model wins over repo defaults
        // (the queueing service already ran the resolver and stamped its
        // decision); fall through to live resolution otherwise.
        const globalSettings = await optioSettingsService
          .getSettings(workspaceId)
          .catch(() => null);
        const resolvedReview = resolveReviewConfig({
          repoReviewAgentType: repoConfig.reviewAgentType ?? null,
          repoDefaultAgentType: repoConfig.defaultAgentType ?? null,
          repoReviewModel: metadata.model ?? metadata.claudeModel ?? repoConfig.reviewModel ?? null,
          globalDefaultReviewAgentType: globalSettings?.defaultReviewAgentType ?? null,
          globalDefaultReviewModel: globalSettings?.defaultReviewModel ?? null,
        });
        const agentType = resolvedReview.agentType;
        const resolvedModel = resolvedReview.model;
        const claudeAuthMode: "api-key" | "max-subscription" | "oauth-token" =
          ((await retrieveSecretWithFallback("CLAUDE_AUTH_MODE", "global", workspaceId).catch(
            () => null,
          )) as any) ?? "api-key";
        const codexAuthMode =
          ((await retrieveSecretWithFallback("CODEX_AUTH_MODE", "global", workspaceId).catch(
            () => null,
          )) as "api-key" | "app-server" | null) ?? "api-key";
        const codexAppServerUrl =
          codexAuthMode === "app-server"
            ? (((await retrieveSecretWithFallback(
                "CODEX_APP_SERVER_URL",
                "global",
                workspaceId,
              ).catch(() => null)) as string | undefined) ?? undefined)
            : undefined;
        const geminiAuthMode =
          ((await retrieveSecretWithFallback("GEMINI_AUTH_MODE", "global", workspaceId).catch(
            () => null,
          )) as "api-key" | "vertex-ai" | null) ?? "api-key";
        const googleCloudProject =
          geminiAuthMode === "vertex-ai"
            ? (((await retrieveSecretWithFallback(
                "GOOGLE_CLOUD_PROJECT",
                "global",
                workspaceId,
              ).catch(() => null)) as string | undefined) ?? undefined)
            : undefined;
        const googleCloudLocation =
          geminiAuthMode === "vertex-ai"
            ? (((await retrieveSecretWithFallback(
                "GOOGLE_CLOUD_LOCATION",
                "global",
                workspaceId,
              ).catch(() => null)) as string | undefined) ?? undefined)
            : undefined;
        const opencodeDefaultBaseUrl =
          ((await retrieveSecretWithFallback(
            "OPENCODE_DEFAULT_BASE_URL",
            "global",
            workspaceId,
          ).catch(() => null)) as string | undefined) ?? undefined;
        const opencodeDefaultModel =
          ((await retrieveSecretWithFallback("OPENCODE_DEFAULT_MODEL", "global", workspaceId).catch(
            () => null,
          )) as string | undefined) ?? undefined;

        const optioApiUrl = `http://${process.env.API_HOST ?? "host.docker.internal"}:${
          process.env.API_PORT ?? "4000"
        }`;

        // ── Build agent config ─────────────────────────────────────
        const adapter = getAdapter(agentType);
        const parsedRepo = parseRepoUrl(review.repoUrl);
        const _repoName = parsedRepo ? `${parsedRepo.owner}/${parsedRepo.repo}` : review.repoUrl;

        // Inject the resolved review model into the field for the resolved
        // agent type. The adapter for `agentType` only reads its own field,
        // but we still pass through the other agents' configured models
        // unchanged so cross-agent settings (e.g. claudeContextWindow) remain
        // available when an adapter happens to consume them.
        const claudeModel =
          agentType === "claude-code" ? resolvedModel : (repoConfig.claudeModel ?? undefined);
        // Codex shares Copilot's copilotModel / copilotEffort, but a repo's
        // values there are Copilot's settings (Codex has none per repo), so a
        // Codex review gets only its resolved review model.
        const copilotModel =
          agentType === "copilot" || agentType === "codex"
            ? resolvedModel
            : (repoConfig.copilotModel ?? undefined);
        const opencodeModel =
          agentType === "opencode"
            ? resolvedModel
            : (repoConfig.opencodeModel ?? opencodeDefaultModel);
        const geminiModel =
          agentType === "gemini" ? resolvedModel : (repoConfig.geminiModel ?? undefined);
        const cursorModel =
          agentType === "cursor" ? resolvedModel : (repoConfig.cursorModel ?? undefined);

        const agentConfig = adapter.buildContainerConfig({
          taskId: run.id,
          prompt: renderedPrompt,
          repoUrl: review.repoUrl,
          repoBranch: repoConfig.defaultBranch,
          claudeAuthMode: claudeAuthMode as "api-key" | "max-subscription",
          codexAuthMode,
          codexAppServerUrl,
          optioApiUrl,
          renderedPrompt,
          taskFileContent,
          taskFilePath,
          claudeModel,
          claudeContextWindow: repoConfig.claudeContextWindow ?? undefined,
          claudeEffort: repoConfig.claudeEffort ?? undefined,
          copilotModel,
          copilotEffort:
            agentType === "codex" ? undefined : (repoConfig.copilotEffort ?? undefined),
          opencodeModel,
          opencodeAgent: repoConfig.opencodeAgent ?? undefined,
          opencodeBaseUrl: repoConfig.opencodeBaseUrl ?? opencodeDefaultBaseUrl,
          cursorModel,
          geminiAuthMode,
          geminiModel,
          geminiApprovalMode:
            (repoConfig.geminiApprovalMode as "default" | "auto_edit" | "yolo") ?? undefined,
          maxTurnsCoding: repoConfig.maxTurnsCoding ?? undefined,
          maxTurnsReview: repoConfig.maxTurnsReview ?? undefined,
          googleCloudProject,
          googleCloudLocation,
        });

        // ── MCP + connections + skills (agent-environment-service) ──
        Object.assign(
          agentConfig.env,
          await buildAgentEnvironment(
            {
              repoUrl: review.repoUrl,
              agentType,
              workspaceId,
              ownerUserId: null,
              // The pod reads the PR's diff — anyone's input — so its
              // connections carry no credentials.
              connectionSecrets: false,
            },
            log,
            agentConfig.setupFiles,
          ),
        );

        // ── Secrets ───────────────────────────────────────────────
        const secretNames = [
          ...new Set([
            ...agentConfig.requiredSecrets,
            ...(!isGitHubAppConfigured() ? ["GITHUB_TOKEN"] : []),
          ]),
        ];
        const resolvedSecrets = await resolveSecretsForTask(
          secretNames,
          review.repoUrl,
          workspaceId,
          userId,
        );
        const allEnv: Record<string, string> = { ...agentConfig.env, ...resolvedSecrets };

        await applyGitAccess(allEnv, { workspaceId, runId: run.id });

        if (repoConfig.extraPackages) allEnv.OPTIO_EXTRA_PACKAGES = repoConfig.extraPackages;
        if (repoConfig.setupCommands) allEnv.OPTIO_SETUP_COMMANDS = repoConfig.setupCommands;

        if (claudeAuthMode === "oauth-token") {
          const oauthToken = await retrieveSecretWithFallback(
            "CLAUDE_CODE_OAUTH_TOKEN",
            "global",
            workspaceId,
            userId,
          ).catch(() => null);
          if (oauthToken) {
            allEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken as string;
          } else {
            throw new Error(
              "OAuth token mode selected but no CLAUDE_CODE_OAUTH_TOKEN secret found.",
            );
          }
        }

        // ── Pod provisioning ──────────────────────────────────────
        // The pod's own env (repo-init.sh): no run's secrets — the pod is shared.
        const podEnv = await repoPool.repoPodEnv(allEnv, review.repoUrl, workspaceId);

        const maxAgentsPerPod = repoConfig.maxAgentsPerPod ?? 2;
        const maxPodInstances = repoConfig.maxPodInstances ?? 1;
        const imageConfig = repoConfig
          ? { preset: (repoConfig.imagePreset ?? "base") as PresetImageId }
          : undefined;
        const pod = await repoPool.getOrCreateRepoPod(
          review.repoUrl,
          repoConfig.defaultBranch,
          podEnv,
          imageConfig,
          {
            preferredPodId: run.lastPodId ?? undefined,
            maxAgentsPerPod,
            maxPodInstances,
            networkPolicy: repoConfig.networkPolicy ?? "unrestricted",
            cpuRequest: repoConfig.cpuRequest,
            cpuLimit: repoConfig.cpuLimit,
            memoryRequest: repoConfig.memoryRequest,
            memoryLimit: repoConfig.memoryLimit,
            dockerInDocker: repoConfig.dockerInDocker ?? false,
            secretProxy: repoConfig.secretProxy ?? false,
            workspaceId,
            isolationPurpose: "review",
          },
        );
        repoPodId = pod.id;

        await db
          .update(prReviewRuns)
          .set({
            containerId: pod.podName ?? pod.podId ?? pod.id,
            podId: pod.id,
            lastPodId: pod.id,
            worktreeState: "active",
            updatedAt: new Date(),
          })
          .where(eq(prReviewRuns.id, runId));

        await transitionRun(runId, PrReviewRunState.RUNNING);

        // ── Build command + exec ─────────────────────────────────
        const agentCommand = buildAgentCommand(agentType, allEnv, {
          resumeSessionId: run.resumeSessionId ?? undefined,
          isReview: true,
          maxTurnsReview: repoConfig.maxTurnsReview ?? undefined,
        });

        const execSession = await repoPool.execTaskInRepoPod(pod, run.id, agentCommand, allEnv);

        // For claude, seed the stream-json stdin with the initial prompt.
        if (agentType === "claude-code") {
          try {
            execSession.stdin.write(buildInitialClaudeStreamMessage(allEnv.OPTIO_PROMPT ?? ""));
          } catch (err) {
            log.warn({ err }, "Failed to write initial claude stdin");
          }
        }

        // ── Stream stdout ───────────────────────────────────────
        let allLogs = "";
        let sessionId: string | undefined;
        let lineBuf = "";
        let pendingActivityAt: Date | null = null;
        let lastActivityFlushAt = 0;
        const ACTIVITY_FLUSH_INTERVAL_MS = 5_000;

        let stderrData = "";
        (async () => {
          for await (const chunk of execSession.stderr as AsyncIterable<Buffer>) {
            stderrData += chunk.toString();
          }
        })().catch(() => {});

        for await (const chunk of execSession.stdout as AsyncIterable<Buffer>) {
          const text = chunk.toString();
          allLogs += text;
          const parts = (lineBuf + text).split("\n");
          lineBuf = parts.pop() ?? "";

          for (const line of parts) {
            if (!line.trim()) continue;
            const parsed = getEventParser(agentType)(line, run.id);

            if (parsed.sessionId && !sessionId) {
              sessionId = parsed.sessionId;
              await db
                .update(prReviewRuns)
                .set({ sessionId, updatedAt: new Date() })
                .where(eq(prReviewRuns.id, run.id));
            }
            if (parsed.isTerminal) {
              try {
                execSession.stdin.end();
              } catch {}
            }
            for (const entry of parsed.entries) {
              await appendRunLog(run, entry.content, "stdout", entry.type, entry.metadata);
              if (["text", "tool_use", "tool_result", "thinking", "system"].includes(entry.type)) {
                pendingActivityAt = new Date();
              }
            }
          }

          if (pendingActivityAt && Date.now() - lastActivityFlushAt > ACTIVITY_FLUSH_INTERVAL_MS) {
            await db
              .update(prReviewRuns)
              .set({ lastActivityAt: pendingActivityAt, updatedAt: new Date() })
              .where(eq(prReviewRuns.id, run.id));
            lastActivityFlushAt = Date.now();
            pendingActivityAt = null;
          }
        }

        if (pendingActivityAt) {
          await db
            .update(prReviewRuns)
            .set({ lastActivityAt: pendingActivityAt, updatedAt: new Date() })
            .where(eq(prReviewRuns.id, run.id));
        }

        // Flush any remaining partial line.
        if (lineBuf.trim()) {
          const parsed = getEventParser(agentType)(lineBuf, run.id);
          for (const entry of parsed.entries) {
            await appendRunLog(run, entry.content, "stdout", entry.type, entry.metadata);
          }
        }

        if (stderrData) {
          log.warn({ stderrPreview: stderrData.slice(0, 500) }, "Exec stderr");
        }

        // ── Parse result ────────────────────────────────────────
        const inferredExitCode = inferExitCode(agentType, allLogs);
        const result = adapter.parseResult(inferredExitCode, allLogs);

        await db
          .update(prReviewRuns)
          .set({
            resultSummary: result.summary,
            errorMessage: result.error ?? null,
            ...addUsage(prReviewRuns, result),
          })
          .where(eq(prReviewRuns.id, run.id));

        if (result.success) {
          await transitionRun(runId, PrReviewRunState.COMPLETED);
          try {
            if (run.kind === "chat") {
              await prReviewService.appendChatReplyFromRun(runId);
            } else {
              await prReviewService.parseReviewOutput(runId);
            }
          } catch (err) {
            log.warn({ err }, "Post-run parser failed");
          }
        } else {
          await transitionRun(runId, PrReviewRunState.FAILED, {
            errorMessage: result.error ?? "Agent failed",
          });
          // Chat runs are follow-up turns on an already-produced draft; their
          // failure is a conversational hiccup, not grounds to invalidate the
          // review. Only initial/rereview runs flip the parent to FAILED.
          if (run.kind !== "chat") {
            await prReviewService.transitionPrReview(
              run.prReviewId,
              PrReviewState.FAILED,
              "run_failed",
              { message: result.error ?? "Agent run failed", runId },
            );
          }
        }

        await enqueueReconcile(
          { kind: "pr-review", id: run.prReviewId },
          { reason: "run_completed" },
        ).catch(() => {});
      } catch (err) {
        log.error({ err }, "PR review run failed");
        const msg = describeError(err);
        await transitionRun(runId, PrReviewRunState.FAILED, { errorMessage: msg }).catch(() => {});
        if (run.kind !== "chat") {
          await prReviewService
            .transitionPrReview(run.prReviewId, PrReviewState.FAILED, "worker_exception", {
              message: msg,
              runId,
            })
            .catch(() => {});
        }
      } finally {
        if (repoPodId) {
          await repoPool.releaseRepoPodTask(repoPodId).catch(() => {});
          await repoPool.updateWorktreeState(run.id, "removed").catch(() => {});
        }
      }
    }),
    {
      ...bullmqOpts,
      concurrency: parseIntEnv("OPTIO_PR_REVIEW_WORKER_CONCURRENCY", 4),
      lockDuration: parseIntEnv("OPTIO_PR_REVIEW_LOCK_MS", 30 * 60 * 1000),
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "pr-review-runs job failed");
  });

  return worker;
}

// Re-export stall threshold so callers can compute heartbeat consistently.
export const PR_REVIEW_STALL_THRESHOLD_MS = DEFAULT_STALL_THRESHOLD_MS;

// Silence unused-import warnings for constants referenced only indirectly.
void sql;
