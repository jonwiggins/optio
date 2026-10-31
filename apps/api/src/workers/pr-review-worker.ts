import {
  GATEWAY_AUTH_MODE,
  applyGatewayEnv,
  resolveGatewayRun,
} from "../services/gateway-run-service.js";
import { gatewayEffort } from "../services/run-effort.js";
import { pricedUsage } from "../services/usage-pricing.js";
import { piProviderSecrets } from "../services/pi-provider-secrets.js";
import { runBudgetHold } from "../services/usage-budget-service.js";
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
 *   - repoPool.startTaskInRepoPod (accepts any stable id for worktree keying)
 *   - the run protocol's shared attach loop (services/run-attachment.ts)
 *   - agent-adapters (buildContainerConfig, parseResult)
 *   - the shared agent-event parsers
 *   - buildAgentCommand exported from task-worker.ts
 */
import { Queue, Worker } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
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
import { runHome } from "../utils/harness-config.js";
import { resolveSecretsForTask, retrieveSecretWithFallback } from "../services/secret-service.js";
import { publishEvent } from "../services/event-bus.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";
import { logger } from "../logger.js";
import * as prReviewService from "../services/pr-review-service.js";
import { enqueueReconcile } from "../services/reconcile-queue.js";
import { resolveReviewConfig } from "../services/review-config.js";
import * as optioSettingsService from "../services/optio-settings-service.js";
import { buildAgentEnvironment } from "../services/agent-environment-service.js";
import { applyGitAccess, requiredGitTokenSecret } from "../services/git-access-env.js";
import { buildInitialClaudeStreamMessage } from "../services/pooled-agent-command.js";
import { buildAgentCommand } from "./task-worker.js";

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
      // A re-attach (the reconciler's `reattach` action): the run is already
      // going in its pod; take it over from where its log rows stop.
      if (job.name === "attach-pr-review-run") {
        await attachReviewRun(job);
        return;
      }
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

      const budgetHold = await runBudgetHold("review", runId);
      if (budgetHold) {
        await db
          .update(prReviewRuns)
          .set({ errorMessage: budgetHold })
          .where(eq(prReviewRuns.id, runId));
        await prReviewRunQueue.add(job.name, job.data, {
          jobId: `${runId}-budget-${Date.now()}`,
          delay: 60_000,
          removeOnComplete: true,
        });
        return;
      }
      await db
        .update(prReviewRuns)
        .set({ errorMessage: null })
        .where(
          and(
            eq(prReviewRuns.id, runId),
            sql`${prReviewRuns.errorMessage} LIKE 'Usage budget reached:%'`,
          ),
        );

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
      // This job's hold on the run, from the claim on (run-attachment.ts);
      // the finally lets go of it through `endRunJob`. A run this job
      // detached from keeps its pod slot for the instance that finishes it.
      const hold = await beginHold(reviewRunRef(runId));
      let slotHeld = false;
      let ended: RunEnd | null = null;
      try {
        const { getRepoByUrl } = await import("../services/repo-service.js");
        const repoConfig = await getRepoByUrl(review.repoUrl, review.workspaceId ?? undefined);
        if (!repoConfig) throw new Error(`Repo ${review.repoUrl} is not configured in Optio`);

        const metadata =
          (run.metadata as {
            taskFileContent?: string;
            taskFilePath?: string;
            // Agent-agnostic model field.
            model?: string;
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
          repoReviewModel: metadata.model ?? repoConfig.reviewModel ?? null,
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

        const gatewayRun = await resolveGatewayRun({
          agentType,
          agentOptions: {
            claudeModel,
            claudeEffort: repoConfig.claudeEffort ?? undefined,
            opencodeModel,
          },
          workspaceId,
          ownerUserId: userId,
          unservedModel: "first",
        });

        const agentConfig = adapter.buildContainerConfig({
          taskId: run.id,
          prompt: renderedPrompt,
          repoUrl: review.repoUrl,
          repoBranch: repoConfig.defaultBranch,
          claudeAuthMode: gatewayRun
            ? GATEWAY_AUTH_MODE
            : (claudeAuthMode as "api-key" | "max-subscription"),
          codexAuthMode,
          codexAppServerUrl,
          modelProviderEnv: gatewayRun?.env,
          optioApiUrl,
          renderedPrompt,
          taskFileContent,
          taskFilePath,
          claudeModel: gatewayRun?.agent === "claude-code" ? gatewayRun.pick.model : claudeModel,
          claudeContextWindow: repoConfig.claudeContextWindow ?? undefined,
          claudeEffort: gatewayRun
            ? gatewayEffort(gatewayRun)
            : (repoConfig.claudeEffort ?? undefined),
          copilotModel,
          copilotEffort:
            agentType === "codex" ? undefined : (repoConfig.copilotEffort ?? undefined),
          opencodeModel: gatewayRun?.agent === "opencode" ? gatewayRun.pick.model : opencodeModel,
          opencodeAuthMode: gatewayRun?.agent === "opencode" ? GATEWAY_AUTH_MODE : undefined,
          opencodeAgent: repoConfig.opencodeAgent ?? undefined,
          opencodeBaseUrl: gatewayRun
            ? undefined
            : (repoConfig.opencodeBaseUrl ?? opencodeDefaultBaseUrl),
          cursorModel,
          piModel: agentType === "pi" ? resolvedModel : undefined,
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
        const gitToken = requiredGitTokenSecret(parsedRepo?.platform);
        const secretNames = [
          ...new Set([...agentConfig.requiredSecrets, ...(gitToken ? [gitToken] : [])]),
        ];
        const resolvedSecrets = await resolveSecretsForTask(
          secretNames,
          review.repoUrl,
          workspaceId,
          userId,
        );
        if (agentType === "pi")
          Object.assign(
            resolvedSecrets,
            await piProviderSecrets((name) =>
              resolveSecretsForTask([name], review.repoUrl, workspaceId, userId)
                .then((values) => values[name])
                .catch(() => null),
            ),
          );

        const allEnv: Record<string, string> = { ...agentConfig.env, ...resolvedSecrets };

        await applyGitAccess(allEnv, { workspaceId, repoUrl: review.repoUrl, runId: run.id });

        if (repoConfig.extraPackages) allEnv.OPTIO_EXTRA_PACKAGES = repoConfig.extraPackages;
        if (repoConfig.setupCommands) allEnv.OPTIO_SETUP_COMMANDS = repoConfig.setupCommands;

        if (gatewayRun) applyGatewayEnv(allEnv, gatewayRun);

        if (!gatewayRun && agentType !== "pi" && claudeAuthMode === "oauth-token") {
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

        // ── Build command + start ────────────────────────────────
        const agentCommand = buildAgentCommand(agentType, allEnv, {
          resumeSessionId: run.resumeSessionId ?? undefined,
          isReview: true,
          maxTurnsReview: repoConfig.maxTurnsReview ?? undefined,
        });

        // What finishing needs that only this job knew: the agent the run
        // was resolved to. Kept on the row for an instance that attaches later.
        await db
          .update(prReviewRuns)
          .set({
            metadata: sql`COALESCE(${prReviewRuns.metadata}, '{}'::jsonb) || ${JSON.stringify({ agentType })}::jsonb`,
          })
          .where(eq(prReviewRuns.id, runId));

        // A review cancelled while the run was set up starts nothing.
        if (await cancelledWithReview(run, log)) return;

        // Start the agent under the run protocol: the start exec returns
        // once the supervisor runs; any API instance can attach to the
        // run's output from here on, and this one does so right away. The
        // run is `running` once its start is recorded.
        const started = await repoPool.startTaskInRepoPod(pod, run.id, agentCommand, allEnv, {
          // For claude, seed the stream-json stdin with the initial prompt.
          initialStdin:
            agentType === "claude-code"
              ? buildInitialClaudeStreamMessage(allEnv.OPTIO_PROMPT ?? "")
              : "",
        });
        slotHeld = true;
        if (started.output.trim()) {
          log.debug({ setup: started.output.slice(-2000) }, "Run setup output");
        }
        // The review cancelled while the agent started (before its start is
        // recorded, and right after): the run is cancelled, its results are
        // never written, and `endRunJob` stops the agent nobody will stream.
        const agent = { podId: pod.id, pid: started.pid };
        hold.agent = agent;
        if (await cancelledWithReview(run, log)) return;
        if (!(await recordRunStarted(hold, agent))) {
          // Requeued while it was set up: the agent is nobody's.
          log.info("The run moved on while its agent started; stopping the agent");
          return;
        }
        if (await cancelledWithReview(run, log)) return;
        const runningNow = await transitionRunIf(
          runId,
          PrReviewRunState.PROVISIONING,
          PrReviewRunState.RUNNING,
        );
        if (!runningNow) {
          // Moved on while it was set up (cancelled): the agent is nobody's.
          log.info("The run moved on while its agent started; stopping the agent");
          return;
        }
        log.info({ pid: started.pid }, "Agent started; attaching");

        ended = await finishReviewRun({
          run,
          agentType,
          pod: { id: pod.id, handle: podPool.podHandle(pod) },
          log,
          hold,
          claim: { consumedBytes: 0, execState: "started", pid: started.pid },
        });
      } catch (err) {
        // Once its agent streams, an error is this instance's trouble, not
        // the run's: the run is left for an attach (run-attachment.ts).
        const afterStart = await onStreamError(hold, log);
        if (afterStart) {
          ended = afterStart;
          log.error(
            { err },
            "PR review worker error while streaming; the run is left for an attach",
          );
          return;
        }
        log.error({ err }, "PR review run failed");
        const msg = describeError(err);
        // Only while the run is still active: a cancel stands.
        await transitionRunFromActive(runId, PrReviewRunState.FAILED, { errorMessage: msg }).catch(
          () => null,
        );
        if (run.kind !== "chat" && !(await reviewIsCancelled(run.prReviewId))) {
          await prReviewService
            .transitionPrReview(run.prReviewId, PrReviewState.FAILED, "worker_exception", {
              message: msg,
              runId,
            })
            .catch(() => {});
        }
      } finally {
        // Let go of the run: an agent this job started and left behind (a
        // run that failed or was cancelled under it) is stopped first, then
        // the lease goes (run-attachment.ts).
        await endRunJob(hold, ended, log);
        if (repoPodId && slotHeld && ended !== "detached") {
          await repoPool.releaseRepoPodTask(repoPodId).catch(() => {});
          await repoPool.updateWorktreeState(run.id, "removed").catch(() => {});
        } else if (repoPodId && !slotHeld) {
          // The agent never started: the start gave the slot back itself.
          await repoPool.updateWorktreeState(run.id, "removed").catch(() => {});
        }
      }
    }),
    {
      ...bullmqOpts,
      concurrency: parseIntEnv("OPTIO_PR_REVIEW_WORKER_CONCURRENCY", 4),
      // See task-worker: the job lasts as long as this instance streams the
      // run; recovery is the attach sweep's, not BullMQ's stall re-delivery.
      lockDuration: parseIntEnv("OPTIO_PR_REVIEW_LOCK_MS", 60_000),
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "pr-review-runs job failed");
  });

  return worker;
}

// Re-export stall threshold so callers can compute heartbeat consistently.
export const PR_REVIEW_STALL_THRESHOLD_MS = DEFAULT_STALL_THRESHOLD_MS;

// ── The run protocol: attaching to a review run's agent and finishing it ─────

/** The attachment columns of a review run's row (run-attachment.ts). */
export function reviewRunRef(runId: string): AttachRef {
  return { kind: "review-run", id: runId };
}

const ACTIVE_RUN_STATES = [
  PrReviewRunState.QUEUED,
  PrReviewRunState.PROVISIONING,
  PrReviewRunState.RUNNING,
];

/**
 * `transitionRun` as one CAS on the run still being active (queued,
 * provisioning, running): a run already cancelled, failed or completed
 * keeps its state. Null when it moved on.
 */
async function transitionRunFromActive(
  runId: string,
  to: PrReviewRunState,
  patch: Partial<typeof prReviewRuns.$inferSelect> = {},
): Promise<typeof prReviewRuns.$inferSelect | null> {
  const terminal =
    to === PrReviewRunState.COMPLETED ||
    to === PrReviewRunState.FAILED ||
    to === PrReviewRunState.CANCELLED;
  const [before] = await db
    .select({ state: prReviewRuns.state })
    .from(prReviewRuns)
    .where(eq(prReviewRuns.id, runId));
  const [updated] = await db
    .update(prReviewRuns)
    .set({
      ...patch,
      state: to,
      updatedAt: new Date(),
      ...(terminal && !patch.completedAt ? { completedAt: new Date() } : {}),
    })
    .where(and(eq(prReviewRuns.id, runId), inArray(prReviewRuns.state, ACTIVE_RUN_STATES)))
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

/**
 * Whether the run's review was cancelled: then the run is marked cancelled
 * (if it is not over already) and nothing of it is ever written to the
 * review. Checked as the run is started — before its agent launches, before
 * its start is recorded and right after — so a cancel that came while the
 * run was being set up is never missed.
 */
async function cancelledWithReview(
  run: typeof prReviewRuns.$inferSelect,
  log: typeof logger,
): Promise<boolean> {
  if (!(await reviewIsCancelled(run.prReviewId))) return false;
  await transitionRunFromActive(run.id, PrReviewRunState.CANCELLED, {
    errorMessage: "Parent review is cancelled",
  });
  log.info("The review was cancelled while its run was set up; cancelling the run");
  return true;
}

/** `transitionRun`, only while the run is still in `from`. Null when it moved on. */
async function transitionRunIf(
  runId: string,
  from: PrReviewRunState,
  to: PrReviewRunState,
): Promise<typeof prReviewRuns.$inferSelect | null> {
  const [current] = await db
    .select({ state: prReviewRuns.state })
    .from(prReviewRuns)
    .where(eq(prReviewRuns.id, runId));
  if (current?.state !== from) return null;
  return transitionRun(runId, to);
}

interface FinishReviewRunInput {
  run: typeof prReviewRuns.$inferSelect;
  agentType: string;
  pod: AttachedPod;
  log: typeof logger;
  hold: AttachmentHold;
  /** Where the run's log rows reach, and whether an earlier holder already recorded its exit. */
  claim: AttachmentClaim;
}

/**
 * Streams a started review run to its end and records its result — the
 * one path for the job that started the run and for a job that attaches
 * to it later. Returns "detached" when this instance stopped streaming
 * without the run ending (shutdown, or another instance took the run).
 */
async function finishReviewRun(input: FinishReviewRunInput): Promise<RunEnd> {
  const { run, agentType, pod, log, hold } = input;
  const runId = run.id;
  const ref = reviewRunRef(runId);
  const runtime = getRuntime();
  const runDir = runHome(runId).podDir;
  const parseEvent = getEventParser(agentType);

  // Derivations: rebuilt from byte 0 on every attach, never persisted.
  const digest = new RunOutputDigest(agentType);
  let pendingActivityAt: Date | null = null;
  let lastActivityFlushAt = 0;
  const ACTIVITY_FLUSH_INTERVAL_MS = 5_000;

  const { outcome } = await streamRun({
    runtime,
    handle: pod.handle,
    ref,
    runDir,
    hold,
    consumedBytes: input.claim.consumedBytes,
    log,
    parse: (line) => parseEvent(line, runId),
    derive: (line) => digest.push(line),
    async onSession(sessionId) {
      await db
        .update(prReviewRuns)
        .set({ sessionId, updatedAt: new Date() })
        .where(eq(prReviewRuns.id, runId));
    },
    onEntries(entries) {
      for (const entry of entries) {
        if (["text", "tool_use", "tool_result", "thinking", "system"].includes(entry.type)) {
          pendingActivityAt = new Date();
        }
      }
    },
    publish: (row) =>
      publishEvent({
        type: "pr_review_run:log",
        prReviewId: run.prReviewId,
        runId,
        stream: (row.stream as "stdout" | "stderr") ?? "stdout",
        content: row.content,
        // The stored row's timestamp, not this process's clock, so the live
        // frame matches the same row in the catch-up / REST history.
        timestamp: row.timestamp.toISOString(),
        logType: row.logType ?? undefined,
        metadata: row.metadata ?? undefined,
      }),
    async onChunk() {
      if (pendingActivityAt && Date.now() - lastActivityFlushAt > ACTIVITY_FLUSH_INTERVAL_MS) {
        await db
          .update(prReviewRuns)
          .set({ lastActivityAt: pendingActivityAt, updatedAt: new Date() })
          .where(eq(prReviewRuns.id, runId));
        lastActivityFlushAt = Date.now();
        pendingActivityAt = null;
      }
    },
  });

  if (pendingActivityAt) {
    await db
      .update(prReviewRuns)
      .set({ lastActivityAt: pendingActivityAt, updatedAt: new Date() })
      .where(eq(prReviewRuns.id, runId));
  }

  if (outcome.kind === "reset") {
    log.info("The run was queued again while its agent ran; leaving this attempt");
    return "reset";
  }
  if (outcome.kind === "taken" || outcome.kind === "detached") {
    log.info({ outcome: outcome.kind }, "Detached from the run; it continues in its pod");
    return "detached";
  }

  if (outcome.kind === "lost") {
    const stderrTail = await readRunStderr(runtime, pod.handle, runDir);
    const settledLost = await settleRun(hold);
    if (settledLost === "taken" || settledLost === "reset") return endOfLoss(settledLost);
    await failLostReviewRun(
      run,
      "The agent's process and its output are gone (the pod restarted while it ran)",
      stderrTail,
    );
    await closeAttachment(hold);
    log.warn("Run lost: the pod restarted under the agent");
    return "finished";
  }

  // ── Parse result ────────────────────────────────────────
  // The agent exited and every line of its output is a log row; its result
  // was read as the output streamed, with the exit code the output implies.
  const result = digest.finish(outcome.code, { inferExitCode: true }).result;
  // A failed run says why in its stderr, which its error carries.
  if (!result.success) {
    result.error = withStderr(
      result.error ?? "Agent failed",
      await readRunStderr(runtime, pod.handle, runDir),
    );
  }

  // The exit with the run's result and spend — once, whichever instance
  // gets here (`settleRun` is a CAS on the exit).
  const settled = await settleRun(hold, {
    resultSummary: result.summary,
    errorMessage: result.error ?? null,
    ...addUsage(prReviewRuns, await pricedUsage({ prReviewId: run.prReviewId, agentType }, result)),
  });
  if (settled === "taken" || settled === "reset") return endOfLoss(settled);

  if (result.success) {
    // Only a run still active completes, and only a review not cancelled
    // gets its results: a cancel stands whatever the agent produced.
    const completed = await transitionRunFromActive(runId, PrReviewRunState.COMPLETED);
    if (!completed || (await reviewIsCancelled(run.prReviewId))) {
      log.info("The run or its review moved on while the agent ran; its results are not written");
    } else {
      try {
        if (run.kind === "chat") {
          await prReviewService.appendChatReplyFromRun(runId);
        } else {
          await prReviewService.parseReviewOutput(runId);
        }
      } catch (err) {
        log.warn({ err }, "Post-run parser failed");
      }
    }
  } else {
    await transitionRunFromActive(runId, PrReviewRunState.FAILED, {
      errorMessage: result.error ?? "Agent failed",
    });
    // Chat runs are follow-up turns on an already-produced draft; their
    // failure is a conversational hiccup, not grounds to invalidate the
    // review. Only initial/rereview runs flip the parent to FAILED — and
    // never a cancelled one (the cancel is what stopped its agent).
    if (run.kind !== "chat" && !(await reviewIsCancelled(run.prReviewId))) {
      await prReviewService.transitionPrReview(run.prReviewId, PrReviewState.FAILED, "run_failed", {
        message: result.error ?? "Agent run failed",
        runId,
      });
    }
  }

  await enqueueReconcile(
    { kind: "pr-review", id: run.prReviewId },
    { reason: "run_completed" },
  ).catch(() => {});

  // The run is over and every byte of its output is a log row: its
  // directory in the pod (output, stdin, the runtime's config) goes.
  await removeRunDirectory(runtime, pod.handle, runDir, log);
  await closeAttachment(hold);
  return "finished";
}

async function reviewIsCancelled(prReviewId: string): Promise<boolean> {
  const [review] = await db
    .select({ state: prReviews.state })
    .from(prReviews)
    .where(eq(prReviews.id, prReviewId));
  return review?.state === PrReviewState.CANCELLED;
}

/** Fails a review run whose agent is gone with its pod (the pod-death path). */
async function failLostReviewRun(
  run: typeof prReviewRuns.$inferSelect,
  detail: string,
  stderrTail = "",
  trigger = "run_lost",
): Promise<void> {
  const msg = withStderr(`${detail}. Inspect before relaunching.`, stderrTail);
  await transitionRunFromActive(run.id, PrReviewRunState.FAILED, { errorMessage: msg });
  if (run.kind !== "chat" && !(await reviewIsCancelled(run.prReviewId))) {
    await prReviewService
      .transitionPrReview(run.prReviewId, PrReviewState.FAILED, trigger, {
        message: msg,
        runId: run.id,
      })
      .catch(() => {});
  }
  await enqueueReconcile(
    { kind: "pr-review", id: run.prReviewId },
    { reason: "run_completed" },
  ).catch(() => {});
}

/**
 * An `attach-pr-review-run` job (the reconciler's `reattach` action): take
 * the run if nobody holds it and finish it from where its log rows stop.
 */
async function attachReviewRun(job: { id?: string; data: unknown }): Promise<void> {
  const { runId } = job.data as { runId: string };
  const log = logger.child({ runId, jobId: job.id, attach: true });
  const [run] = await db.select().from(prReviewRuns).where(eq(prReviewRuns.id, runId));
  if (
    !run ||
    (run.state !== PrReviewRunState.RUNNING && run.state !== PrReviewRunState.PROVISIONING)
  ) {
    log.info({ state: run?.state }, "Skipping attach — the run is not active");
    return;
  }
  const agentType = (run.metadata as { agentType?: string } | null)?.agentType;
  if (!agentType) {
    log.warn("Skipping attach — the run does not say which agent it runs");
    return;
  }
  try {
    await runAttachJob({
      ref: reviewRunRef(runId),
      log,
      podId: run.podId ?? null,
      onPodGone: (detail) => failLostReviewRun(run, detail),
      onAttachFailed: (message) => failLostReviewRun(run, message, "", "attach_failed"),
      async finish(pod, hold, claim) {
        // The instance that started the agent went away before recording `running`.
        await transitionRunIf(runId, PrReviewRunState.PROVISIONING, PrReviewRunState.RUNNING);
        return finishReviewRun({ run, agentType, pod, log, hold, claim });
      },
      afterFinish: async (podId) => {
        if (podId) await repoPool.releaseRepoPodTask(podId).catch(() => {});
        await repoPool.updateWorktreeState(runId, "removed").catch(() => {});
      },
    });
  } catch (err) {
    log.error({ err }, "Attach failed; the run stays for the next attach");
    throw err;
  }
}
