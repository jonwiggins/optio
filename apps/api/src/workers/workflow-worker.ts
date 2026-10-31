import { runBudgetHold } from "../services/usage-budget-service.js";
import { workCredentialProfile } from "../services/pod-isolation.js";
import { Worker, Queue } from "bullmq";
import {
  WorkflowRunState,
  canTransitionWorkflowRun,
  DEFAULT_MAX_TURNS_CODING,
  parseIntEnv,
  describeError,
} from "@optio/shared";
import { getEventParser } from "../services/event-parsers.js";
import { db } from "../db/client.js";
import { workflowRuns, workRuns } from "../db/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { updatedAtMatches } from "../utils/pg-timestamp.js";
import * as workflowService from "../services/workflow-service.js";
import {
  claimWorkflowRunIn,
  transitionWorkflowRunCas,
  type Workflow,
} from "../services/workflow-service.js";
import { COMMAND_SCRIPT, commandResult, parseCommandLine } from "../services/command-run.js";
import { renderCommandTemplate } from "../services/prompt-template-service.js";
import * as workflowPool from "../services/workflow-pool-service.js";
import * as podPool from "../services/agent-pod-pool.js";
import { getRuntime } from "../services/container-service.js";
import { publishWorkflowRunEvent } from "../services/event-bus.js";
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
  signalRun,
  streamRun,
  withStderr,
  type AttachRef,
  type AttachmentClaim,
  type AttachmentHold,
  type AttachedPod,
  type ParsedRunLine,
  type RunEnd,
  type StreamRunResult,
} from "../services/run-attachment.js";
import { RunOutputDigest } from "../services/run-output-digest.js";
import { runHome } from "../utils/harness-config.js";
import { addUsage } from "../services/run-usage.js";
import { activityFlusher } from "../services/activity-flush.js";
import { WORKFLOW_CLAIM_KEY, withClaimLock } from "../services/claim-lock.js";
import { resolvePodSecrets } from "../services/secret-service.js";
import { recordAuthEvent } from "../services/auth-failure-detector.js";
import {
  buildInitialClaudeStreamMessage,
  buildPooledAgentCommand,
} from "../services/pooled-agent-command.js";
import { pooledAgentEnv } from "../services/pooled-agent-env.js";
import {
  buildAgentEnvironment,
  connectionShellEnv,
} from "../services/agent-environment-service.js";
import { logger } from "../logger.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

import { getBullMQOptions } from "../services/redis-config.js";

const bullmqOpts = getBullMQOptions();

/** How often a run's last-activity time is written while its agent works. */
const ACTIVITY_FLUSH_MS = 10_000;

export const workflowRunQueue = new Queue("workflow-runs", { ...bullmqOpts });

// ── Helpers (exported for testing) ─────────────────────────────────────────────

/**
 * Render a workflow prompt template by replacing `{{key}}` placeholders
 * with values from the params object.
 */
export function renderWorkflowPrompt(
  template: string,
  params?: Record<string, unknown> | null,
): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key in params) return String(params[key]);
    return match;
  });
}

/**
 * What a Job run executes, rendered with its params: the agent's prompt, or
 * — for a command Job — the shell command, its params shell-quoted so a
 * trigger payload can never inject shell syntax.
 */
export function renderJobInput(
  workflow: Pick<Workflow, "agentRuntime" | "promptTemplate">,
  params: unknown,
): string {
  const values = (params ?? null) as Record<string, unknown> | null;
  return workflowService.isCommandJob(workflow)
    ? renderCommandTemplate(workflow.promptTemplate, values)
    : renderWorkflowPrompt(workflow.promptTemplate, values);
}

/**
 * Build the agent command for a workflow run. Similar to task-worker's
 * buildAgentCommand but simplified — no resume, no review mode.
 */
export function buildWorkflowAgentCommand(
  agentType: string,
  env: Record<string, string>,
  opts?: { maxTurns?: number },
): string[] {
  return buildPooledAgentCommand(agentType, env, {
    maxTurns: opts?.maxTurns ?? DEFAULT_MAX_TURNS_CODING,
    label: "workflow agent",
  });
}

// ── Worker ─────────────────────────────────────────────────────────────────────

export function startWorkflowWorker() {
  const worker = new Worker(
    "workflow-runs",
    instrumentWorkerProcessor("workflow-worker", async (job) => {
      // A re-attach (the reconciler's `reattach` action): the run is already
      // going in its pod; take it over from where its log rows stop.
      if (job.name === "attach-workflow-run") {
        await attachWorkflowRun(job);
        return;
      }
      const { workflowRunId, provisioningRetryCount = 0 } = job.data as {
        workflowRunId: string;
        provisioningRetryCount?: number;
      };
      const log = logger.child({ workflowRunId, jobId: job.id });
      let workflowPodId: string | null = null;
      let attemptStartedAt: Date | undefined;
      let executionAttempted = false;
      // This job's hold on the run, from the claim on (run-attachment.ts);
      // the finally lets go of it through `endRunJob`. A run this job
      // detached from keeps its pod slot for the instance that finishes it.
      let hold: AttachmentHold | null = null;
      let ended: RunEnd | null = null;

      try {
        // ── Verify run is in queued state ──────────────────────────────
        const run = await workflowService.getWorkflowRun(workflowRunId);
        if (!run || run.state !== WorkflowRunState.QUEUED) {
          log.info({ state: run?.state }, "Skipping — run is not in queued state");
          return;
        }

        // ── Load workflow definition ──────────────────────────────────
        const workflow = await workflowService.getWorkflow(run.workflowId);
        if (!workflow) {
          throw new Error(`Workflow not found: ${run.workflowId}`);
        }
        if (!workflow.enabled) {
          log.info("Workflow is disabled, failing run");
          await transitionWorkflowRunCas(
            workflowRunId,
            WorkflowRunState.QUEUED,
            WorkflowRunState.FAILED,
            { errorMessage: "Workflow is disabled" },
          );
          return;
        }

        const budgetHold = await runBudgetHold("job", workflowRunId);
        if (budgetHold) {
          await db
            .update(workflowRuns)
            .set({ errorMessage: budgetHold, reconcileBackoffUntil: new Date(Date.now() + 60_000) })
            .where(eq(workflowRuns.id, workflowRunId));
          await workflowRunQueue.add(job.name, job.data, {
            jobId: `${workflowRunId}-budget-${Date.now()}`,
            delay: 60_000,
            removeOnComplete: true,
          });
          return;
        }
        await db
          .update(workflowRuns)
          .set({ errorMessage: null })
          .where(
            and(
              eq(workflowRuns.id, workflowRunId),
              sql`${workflowRuns.errorMessage} LIKE 'Usage budget reached:%'`,
            ),
          );

        // ── Local run: hand off to the owner's machine ─────────────────
        // No pod, no cluster concurrency. The Optio Local daemon runs the
        // agent in the job's directory; the terminal's lifecycle drives the
        // run's state from here on (services/local-run-service.ts). The
        // run stays queued while the host is offline (terminal parked) and
        // a re-enqueue for an already-dispatched run is a no-op.
        if (workflow.runTarget === "local") {
          const { dispatchLocalWorkflowRun } = await import("../services/local-run-service.js");
          const terminal = await dispatchLocalWorkflowRun(
            run,
            workflow,
            renderJobInput(workflow, run.params),
          );
          log.info(
            { terminalId: terminal?.id ?? null, terminalState: terminal?.state ?? null },
            "Workflow run dispatched to a local host",
          );
          return;
        }

        // ── Concurrency check ─────────────────────────────────────────
        // Under the advisory lock for the global limit, so claimers on every
        // API instance count one at a time (claim-lock.ts); this Job's own
        // limit is counted under the same lock. Null when another worker
        // held the lock past its timeout: re-queue.
        const claimed = await withClaimLock([WORKFLOW_CLAIM_KEY], async (claim) => {
          // Global workflow concurrency (cluster runs only; local runs don't
          // occupy pods), then this workflow's own.
          const capacity = await workflowService.jobRunCapacity(
            workflow.id,
            workflow.maxConcurrent,
            claim.tx,
          );
          if (capacity.global.running >= capacity.global.max) {
            log.info(
              { activeCount: capacity.global.running, globalMax: capacity.global.max },
              "Global workflow concurrency saturated",
            );
            return null;
          }
          if (capacity.job.running >= capacity.job.max) {
            log.info(
              { activeCount: capacity.job.running, max: capacity.job.max },
              "Per-workflow concurrency saturated",
            );
            return null;
          }

          // Claim: transition to running. CAS — a second worker holding the
          // same run (a reconcile re-enqueue) loses here instead of running it twice.
          // The claim is the attempt's first sign of life: a retried run must
          // not be judged stalled by the previous attempt's last activity.
          // On the lock's transaction, so it commits before the lock goes;
          // its announcement runs after the commit.
          const now = new Date();
          return claimWorkflowRunIn(
            claim,
            workflowRunId,
            WorkflowRunState.QUEUED,
            WorkflowRunState.RUNNING,
            { startedAt: now, lastActivityAt: now },
          );
        });

        if (!claimed) {
          // Re-queue with delay
          const jitter = Math.floor(Math.random() * 5000);
          await workflowRunQueue.add("process-workflow-run", job.data, {
            jobId: `${workflowRunId}-delayed-${Date.now()}`,
            delay: 10_000 + jitter,
          });
          return;
        }
        // This attempt — every later write is conditional on still owning it.
        attemptStartedAt = claimed.startedAt!;
        const attempt = attemptStartedAt;
        const thisAttempt = () =>
          and(
            eq(workflowRuns.id, workflowRunId),
            updatedAtMatches(workflowRuns.startedAt, attempt),
          );
        log.info("Workflow run claimed, provisioning pod");
        hold = await beginHold(workflowRunRef(workflowRunId));

        // ── Render the prompt (or the command) ────────────────────────
        const command = workflowService.isCommandJob(workflow);
        const rendered = renderJobInput(workflow, run.params);
        // What this attempt runs (the Job is read live, so it can differ per
        // attempt). Not a state change: the reconciler's version is left alone.
        await db
          .update(workflowRuns)
          .set({ prompt: rendered, agentType: command ? null : workflow.agentRuntime })
          .where(thisAttempt());

        // ── Resolve secrets ───────────────────────────────────────────
        const workspaceId = workflow.workspaceId ?? null;
        // Personal work runs with its owner's secrets; organization work never
        // sees anyone's (see services/work-ownership.ts).
        const workflowUserId = workflow.ownerUserId ?? null;
        // A team's Job runs with the team's secrets, never its creator's own.
        const workflowTeamId = workflow.ownerTeamId ?? null;
        const team = workflowTeamId ? { ownerTeamId: workflowTeamId } : {};
        const picked = await resolvePodSecrets(workflow.podSecrets, {
          workspaceId,
          ownerUserId: workflowUserId,
          ...team,
        });
        if (picked.missing.length > 0) {
          log.warn({ missing: picked.missing }, "Picked pod secrets not found");
        }
        // A command runs with the picked secrets alone; an agent also needs
        // its sign-in and its parameters.
        const env: Record<string, string> = {
          ...picked.env,
          ...(command
            ? { OPTIO_COMMAND: rendered }
            : await pooledAgentEnv(
                workflow,
                rendered,
                workspaceId,
                workflowUserId,
                ...(workflowTeamId ? [workflowTeamId] : []),
              )),
        };

        // The agent's environment: the workspace's MCP servers, connections,
        // and skills with the Job's settings applied, and its setup commands
        // (a command gets only those).
        const environmentInput = {
          repoUrl: null,
          agentType: command ? null : workflow.agentRuntime,
          workspaceId,
          ownerUserId: workflowUserId,
          ...team,
          settings: workflow.settings,
          runId: workflowRunId,
          controllerRunKind: "work-run" as const,
        };
        Object.assign(
          env,
          await buildAgentEnvironment(environmentInput, log),
          // Last: a connection's shell env is the Job's own choice.
          await connectionShellEnv(environmentInput),
        );

        // ── Provision pod (shared across runs within the workflow) ────
        const envSpec = workflow.environmentSpec as Record<string, string> | null;
        const pod = await workflowPool.getOrCreateWorkflowPod(workflow.id, {
          // Same-pod retry affinity — prefer the pod the previous attempt used.
          preferredPodId: run.lastPodId ?? undefined,
          maxAgentsPerPod: workflow.maxAgentsPerPod,
          maxPodInstances: workflow.maxPodInstances,
          workspaceId,
          ownerUserId: workflowUserId,
          ...team,
          credentialProfile: workCredentialProfile(workflow),
          cpuRequest: envSpec?.cpuRequest ?? null,
          cpuLimit: envSpec?.cpuLimit ?? null,
          memoryRequest: envSpec?.memoryRequest ?? null,
          memoryLimit: envSpec?.memoryLimit ?? null,
        });

        // Record the assigned pod on the run so reconcile/zombie code can find
        // it, and remember it as lastPodId for retry affinity.
        await db
          .update(workflowRuns)
          .set({
            podName: pod.podName,
            podId: pod.id,
            lastPodId: pod.id,
            updatedAt: new Date(),
          })
          .where(eq(workflowRuns.id, workflowRunId));

        log.info({ podName: pod.podName }, "Workflow pod ready, executing agent");

        // ── Build and execute the agent (or the command) ──────────────
        const agentCommand = command
          ? [...COMMAND_SCRIPT]
          : buildWorkflowAgentCommand(workflow.agentRuntime, env, {
              maxTurns: workflow.maxTurns ?? undefined,
            });

        // Start the agent under the run protocol: the start exec returns
        // once the supervisor runs; any API instance can attach to the
        // run's output from here on, and this one does so right away.
        executionAttempted = true;
        const started = await workflowPool.startRunInPod(pod, workflowRunId, agentCommand, env, {
          // For claude-code, the prompt arrives via stdin (stream-json mode).
          initialStdin:
            !command && workflow.agentRuntime === "claude-code"
              ? buildInitialClaudeStreamMessage(rendered)
              : "",
        });
        // The attempt holds a slot on the pod from here; the finally gives it
        // back unless the run goes on without this instance.
        workflowPodId = pod.id;
        if (started.output.trim()) {
          log.debug({ setup: started.output.slice(-2000) }, "Run setup output");
        }
        const agent = { podId: pod.id, pid: started.pid };
        if (!(await recordRunStarted(hold, agent))) {
          // Queued again meanwhile: not ours to stream at all, and
          // `endRunJob` stops the agent nobody will.
          log.info("The run moved on while its agent started; stopping the agent");
          return;
        }
        // Cancelled (or failed by the reconciler) while it was set up: the
        // agent is nobody's — stop it, and stream it to its end as usual.
        const [current] = await db
          .select({ state: workflowRuns.state })
          .from(workflowRuns)
          .where(thisAttempt());
        if (current?.state !== WorkflowRunState.RUNNING) {
          await signalRun(pod.id, workflowRunId, "TERM", { pid: started.pid });
        }
        log.info({ pid: started.pid }, "Agent started; attaching");

        ended = await finishWorkflowRun({
          workflowRunId,
          agentType: command ? null : workflow.agentRuntime,
          attemptStartedAt: attempt,
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
            "Workflow worker error while streaming; the run is left for an attach",
          );
          return;
        }
        log.error({ err }, "Workflow worker error");
        try {
          const currentRun = await workflowService.getWorkflowRun(workflowRunId);
          if (currentRun && currentRun.state !== WorkflowRunState.COMPLETED) {
            const fromState = currentRun.state as WorkflowRunState;

            // Provisioning retry for recoverable errors
            if (fromState === WorkflowRunState.RUNNING && !executionAttempted) {
              const MAX_PROVISIONING_RETRIES = 3;
              if (provisioningRetryCount < MAX_PROVISIONING_RETRIES) {
                log.warn(
                  { provisioningRetryCount: provisioningRetryCount + 1 },
                  "Provisioning error, re-queuing",
                );
                // Only while this attempt still owns the run: a cancel or the
                // reconciler may have failed it meanwhile, and that stands.
                const failed = await transitionWorkflowRunCas(
                  workflowRunId,
                  fromState,
                  WorkflowRunState.FAILED,
                  { errorMessage: describeError(err) },
                  { startedAt: attemptStartedAt },
                );
                if (!failed) throw err;
                await transitionWorkflowRunCas(
                  workflowRunId,
                  WorkflowRunState.FAILED,
                  WorkflowRunState.QUEUED,
                );
                const jitter = Math.floor(Math.random() * 5000);
                await workflowRunQueue.add(
                  "process-workflow-run",
                  {
                    workflowRunId,
                    provisioningRetryCount: provisioningRetryCount + 1,
                  },
                  {
                    jobId: `${workflowRunId}-provretry-${Date.now()}`,
                    delay: 30_000 + jitter,
                  },
                );
                return;
              }
            }

            // Terminal failure (of this attempt, if it got as far as claiming one)
            if (canTransitionWorkflowRun(fromState, WorkflowRunState.FAILED)) {
              await transitionWorkflowRunCas(
                workflowRunId,
                fromState,
                WorkflowRunState.FAILED,
                {
                  errorMessage: executionAttempted
                    ? `Execution outcome unknown: ${describeError(err)}. Inspect before retrying.`
                    : describeError(err),
                  recoveryRequired: executionAttempted,
                  finishedAt: new Date(),
                },
                { startedAt: attemptStartedAt },
              );
            }
          }
        } catch {
          // May fail if already terminal
        }
        throw err;
      } finally {
        // Let go of the run: an agent this job started and left behind is
        // stopped first, then the lease goes (run-attachment.ts).
        await endRunJob(hold, ended, log);
        if (workflowPodId && ended !== "detached") {
          await workflowPool.releaseRun(workflowRunId, workflowPodId, attemptStartedAt);
        }
      }
    }),
    {
      ...bullmqOpts,
      concurrency: parseIntEnv("OPTIO_MAX_WORKFLOW_CONCURRENT", 5),
      // See task-worker: the job lasts as long as this instance streams the
      // run; recovery is the attach sweep's, not BullMQ's stall re-delivery.
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Workflow job failed");
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Workflow job completed");
  });

  return worker;
}

// ── The run protocol: attaching to a Job run's agent and finishing the run ───

/** The attachment columns of a Job run's row (run-attachment.ts). */
export function workflowRunRef(workflowRunId: string): AttachRef {
  return { kind: "work-run", id: workflowRunId };
}

interface FinishWorkflowRunInput {
  workflowRunId: string;
  /**
   * What this attempt runs, as its start recorded it on the run row (the
   * Job is read live and may have been edited since): the agent type, or
   * null for a command — plain output lines, the last one its exit status.
   */
  agentType: string | null;
  /** The attempt this instance streams: every state write is conditional on it. */
  attemptStartedAt: Date;
  pod: AttachedPod;
  log: typeof logger;
  hold: AttachmentHold;
  /** Where the run's log rows reach, and whether an earlier holder already recorded its exit. */
  claim: AttachmentClaim;
}

/**
 * Streams a started Job run to its end and records its result — the one
 * path for the job that started the run and for a job that attaches to it
 * later. Returns "detached" when this instance stopped streaming without
 * the run ending (shutdown, or another instance took the run).
 */
async function finishWorkflowRun(input: FinishWorkflowRunInput): Promise<RunEnd> {
  const { workflowRunId, agentType, attemptStartedAt, pod, log, hold } = input;
  const command = agentType === null;
  const ref = workflowRunRef(workflowRunId);
  const runtime = getRuntime();
  const runDir = runHome(workflowRunId).podDir;
  const thisAttempt = () =>
    and(
      eq(workflowRuns.id, workflowRunId),
      updatedAtMatches(workflowRuns.startedAt, attemptStartedAt),
    );

  // Derivations: rebuilt from byte 0 on every attach, never persisted. An
  // agent's output is read for its result as it streams; a command's is
  // plain lines, the last one its exit status (the receipt).
  let exitCode: number | undefined;
  const agentParser = command ? null : getEventParser(agentType);
  const parse = (line: string): ParsedRunLine => {
    if (agentParser) return agentParser(line, workflowRunId);
    const parsed = parseCommandLine(line, workflowRunId);
    if (parsed.exitCode !== undefined) exitCode = parsed.exitCode;
    return { entries: parsed.entries };
  };
  const digest = command ? null : new RunOutputDigest(agentType);

  // Signs of life, written at most every ACTIVITY_FLUSH_MS.
  // Only this attempt's: a zombie earlier attempt still streaming must
  // not keep a stalled retry looking alive.
  const activity = activityFlusher(
    (at) => db.update(workflowRuns).set({ lastActivityAt: at }).where(thisAttempt()),
    ACTIVITY_FLUSH_MS,
  );
  // A command can work quietly for a long time; while its stream is
  // open, it is alive.
  const keepAlive = command
    ? setInterval(() => {
        activity.mark("system");
        void activity.maybeFlush().catch(() => {});
      }, ACTIVITY_FLUSH_MS)
    : null;

  let streamed: StreamRunResult;
  try {
    streamed = await streamRun({
      runtime,
      handle: pod.handle,
      ref,
      runDir,
      hold,
      consumedBytes: input.claim.consumedBytes,
      log,
      parse,
      derive: digest ? (line) => digest.push(line) : undefined,
      async onSession(sessionId) {
        await db
          .update(workflowRuns)
          .set({ sessionId, updatedAt: new Date() })
          .where(eq(workflowRuns.id, workflowRunId));
        log.info({ sessionId }, "Session ID captured");
      },
      // Stall detection: meaningful agent events are signs of life.
      onEntries(entries) {
        for (const entry of entries) activity.mark(entry.type);
      },
      // The live frame (WS) for the stored row.
      publish: (row) =>
        publishWorkflowRunEvent({
          type: "workflow_run:log",
          workflowRunId,
          stream: (row.stream as "stdout" | "stderr") ?? "stdout",
          content: row.content,
          timestamp: row.timestamp?.toISOString() ?? new Date().toISOString(),
          logType: row.logType ?? undefined,
          metadata: row.metadata ?? undefined,
        }),
      onChunk: () => activity.maybeFlush(),
    });
  } finally {
    if (keepAlive) clearInterval(keepAlive);
  }
  await activity.flush();
  const { outcome } = streamed;

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
    await failLostRun(
      workflowRunId,
      attemptStartedAt,
      "the run's process and output are gone (the pod restarted while it ran)",
      log,
      stderrTail,
    );
    await closeAttachment(hold);
    return "finished";
  }

  // ── Parse result and update run ───────────────────────────────
  // The agent exited and every line of its output is a log row; its
  // result was read as the output streamed.
  const verdict = digest ? digest.finish(outcome.code) : null;
  const result = verdict ? verdict.result : commandResult(exitCode);

  // Override a nominally-successful result if the agent emitted an auth
  // failure mid-run. Claude CLIs typically catch the 401 internally and
  // exit 0, which would otherwise mark the run as completed despite no
  // useful work being done. (A command's output is its own business.)
  const authDetection = verdict?.auth ?? null;
  let effectiveSuccess = result.success;
  let effectiveError = result.error;
  if (authDetection?.matched) {
    effectiveSuccess = false;
    effectiveError = `Agent authentication failed: ${authDetection.excerpt ?? authDetection.pattern}`;
    log.warn(
      { pattern: authDetection.pattern, excerpt: authDetection.excerpt },
      "Auth failure detected in agent output — overriding result",
    );
    recordAuthEvent(
      "claude",
      authDetection.excerpt ?? authDetection.pattern ?? "auth_failure",
      "workflow-worker",
    ).catch(() => {});
  }

  // A failed run says why in its stderr, which the failure message carries.
  if (!effectiveSuccess) {
    const stderrTail = await readRunStderr(runtime, pod.handle, runDir);
    effectiveError = withStderr(
      effectiveError ?? (command ? "Command failed" : "Agent execution failed"),
      stderrTail,
    );
  }

  // Record the exit with this attempt's spend ADDED to the run's — once,
  // whichever instance gets here (`settleRun` is a CAS on the exit), and
  // whatever became of the run meanwhile (cancelled): it was spent. Not a
  // state change, so it leaves the reconciler's version alone. (A command
  // spends nothing.)
  const settled = await settleRun(hold, addUsage(workRuns, result));
  if (settled === "taken" || settled === "reset") return endOfLoss(settled);

  const finished = effectiveSuccess
    ? await transitionWorkflowRunCas(
        workflowRunId,
        WorkflowRunState.RUNNING,
        WorkflowRunState.COMPLETED,
        { output: { summary: result.summary }, finishedAt: new Date() },
        { startedAt: attemptStartedAt },
      )
    : await transitionWorkflowRunCas(
        workflowRunId,
        WorkflowRunState.RUNNING,
        WorkflowRunState.FAILED,
        {
          errorMessage: effectiveError ?? (command ? "Command failed" : "Agent execution failed"),
          finishedAt: new Date(),
        },
        { startedAt: attemptStartedAt },
      );
  // The reconciler's decideFailed handles the FAILED→QUEUED retry +
  // exponential backoff; the transition wakes it.
  if (!finished) log.info("Run moved on while the agent ran; its result is not recorded");
  else if (effectiveSuccess) log.info("Workflow run completed");
  else log.warn({ error: effectiveError }, "Workflow run failed");

  // The run is over and every byte of its output is a log row: its
  // directory in the pod (output, stdin, the runtime's config) goes.
  await removeRunDirectory(runtime, pod.handle, runDir, log);
  await closeAttachment(hold);
  return "finished";
}

/** Fails a Job run whose agent is gone with its pod (the pod-death path). */
async function failLostRun(
  workflowRunId: string,
  attemptStartedAt: Date,
  detail: string,
  log: typeof logger,
  stderrTail = "",
): Promise<void> {
  const failed = await transitionWorkflowRunCas(
    workflowRunId,
    WorkflowRunState.RUNNING,
    WorkflowRunState.FAILED,
    {
      errorMessage: withStderr(
        `Execution outcome unknown: ${detail}. Inspect before retrying.`,
        stderrTail,
      ),
      recoveryRequired: true,
      finishedAt: new Date(),
    },
    { startedAt: attemptStartedAt },
  );
  if (!failed) log.info("Run moved on while the agent ran; its loss is not recorded");
  else log.warn({ detail }, "Run lost with its pod");
}

/**
 * An `attach-workflow-run` job (the reconciler's `reattach` action): take
 * the run if nobody holds it and finish it from where its log rows stop.
 */
async function attachWorkflowRun(job: { id?: string; data: unknown }): Promise<void> {
  const { workflowRunId } = job.data as { workflowRunId: string };
  const log = logger.child({ workflowRunId, jobId: job.id, attach: true });
  const run = await workflowService.getWorkflowRun(workflowRunId);
  if (!run || run.state !== WorkflowRunState.RUNNING || run.localTerminalId || !run.startedAt) {
    log.info({ state: run?.state }, "Skipping attach — the run is not an active pod run");
    return;
  }
  const attemptStartedAt = run.startedAt;
  // What this attempt runs, as its start recorded it — never the Job's live
  // definition, which may have been edited since (an agent made a command).
  const agentType = run.agentType ?? null;
  try {
    await runAttachJob({
      ref: workflowRunRef(workflowRunId),
      log,
      podId: run.podId ?? null,
      onPodGone: (detail) => failLostRun(workflowRunId, attemptStartedAt, detail, log),
      async onAttachFailed(message) {
        await transitionWorkflowRunCas(
          workflowRunId,
          WorkflowRunState.RUNNING,
          WorkflowRunState.FAILED,
          { errorMessage: message, recoveryRequired: true, finishedAt: new Date() },
          { startedAt: attemptStartedAt },
        );
      },
      finish: (pod, hold, claim) =>
        finishWorkflowRun({
          workflowRunId,
          agentType,
          attemptStartedAt,
          pod,
          log,
          hold,
          claim,
        }),
      afterFinish: async (podId) => {
        if (podId) await workflowPool.releaseRun(workflowRunId, podId, attemptStartedAt);
      },
    });
  } catch (err) {
    log.error({ err }, "Attach failed; the run stays for the next attach");
    throw err;
  }
}
