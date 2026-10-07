import { workCredentialProfile } from "../services/pod-isolation.js";
import { Worker, Queue } from "bullmq";
import {
  WorkflowRunState,
  canTransitionWorkflowRun,
  DEFAULT_MAX_TURNS_CODING,
  parseIntEnv,
} from "@optio/shared";
import { getAdapter } from "@optio/agent-adapters";
import { getEventParser, type AgentEventParser } from "../services/event-parsers.js";
import { db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { updatedAtMatches } from "../utils/pg-timestamp.js";
import * as workflowService from "../services/workflow-service.js";
import { transitionWorkflowRunCas, type Workflow } from "../services/workflow-service.js";
import { COMMAND_SCRIPT, commandResult, parseCommandLine } from "../services/command-run.js";
import { renderCommandTemplate } from "../services/prompt-template-service.js";
import * as workflowPool from "../services/workflow-pool-service.js";
import { addUsage } from "../services/run-usage.js";
import { activityFlusher } from "../services/activity-flush.js";
import { resolvePodSecrets } from "../services/secret-service.js";
import { detectAuthFailureInLogs, recordAuthEvent } from "../services/auth-failure-detector.js";
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

// ── Concurrency lock ───────────────────────────────────────────────────────────

let claimLockChain: Promise<void> = Promise.resolve();

function withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
  let releaseLock!: () => void;
  const nextLink = new Promise<void>((r) => (releaseLock = r));
  const prev = claimLockChain;
  claimLockChain = nextLink;
  return prev.then(fn).finally(releaseLock);
}

// ── Worker ─────────────────────────────────────────────────────────────────────

export function startWorkflowWorker() {
  const worker = new Worker(
    "workflow-runs",
    instrumentWorkerProcessor("workflow-worker", async (job) => {
      const { workflowRunId, provisioningRetryCount = 0 } = job.data as {
        workflowRunId: string;
        provisioningRetryCount?: number;
      };
      const log = logger.child({ workflowRunId, jobId: job.id });
      let workflowPodId: string | null = null;
      let attemptStartedAt: Date | undefined;
      let executionAttempted = false;

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
        const claimed = await withClaimLock(async () => {
          // Global workflow concurrency (cluster runs only; local runs don't
          // occupy pods), then this workflow's own.
          const capacity = await workflowService.jobRunCapacity(
            workflow.id,
            workflow.maxConcurrent,
          );
          if (capacity.global.running >= capacity.global.max) {
            log.info(
              { activeCount: capacity.global.running, globalMax: capacity.global.max },
              "Global workflow concurrency saturated",
            );
            return false;
          }
          if (capacity.job.running >= capacity.job.max) {
            log.info(
              { activeCount: capacity.job.running, max: capacity.job.max },
              "Per-workflow concurrency saturated",
            );
            return false;
          }

          // Claim: transition to running. CAS — a second worker holding the
          // same run (a reconcile re-enqueue) loses here instead of running it twice.
          // The claim is the attempt's first sign of life: a retried run must
          // not be judged stalled by the previous attempt's last activity.
          const now = new Date();
          return transitionWorkflowRunCas(
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
        const picked = await resolvePodSecrets(workflow.podSecrets, {
          workspaceId,
          ownerUserId: workflowUserId,
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
            : await pooledAgentEnv(workflow, rendered, workspaceId, workflowUserId)),
        };

        // The agent's environment: the workspace's MCP servers, connections,
        // and skills with the Job's settings applied, and its setup commands
        // (a command gets only those).
        const environmentInput = {
          repoUrl: null,
          agentType: command ? null : workflow.agentRuntime,
          workspaceId,
          ownerUserId: workflowUserId,
          settings: workflow.settings,
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

        executionAttempted = true;
        const execSession = await workflowPool.execRunInPod(pod, workflowRunId, agentCommand, env);
        // The attempt holds a slot on the pod from here; the finally gives it back.
        workflowPodId = pod.id;

        // For claude-code, deliver prompt via stdin (stream-json mode)
        if (!command && workflow.agentRuntime === "claude-code") {
          try {
            execSession.stdin.write(buildInitialClaudeStreamMessage(rendered));
          } catch (err) {
            log.warn({ err }, "Failed to write initial prompt to agent stdin");
          }
        }

        // ── Stream stdout with NDJSON parsing ─────────────────────────
        let allLogs = "";
        let sessionId: string | undefined;
        let lineBuf = "";

        // Pick the right event parser for the agent type; a command's output
        // is plain lines, the last one its exit status.
        let exitCode: number | undefined;
        let processExitCode: number | undefined;
        const agentParser = getEventParser(workflow.agentRuntime);
        const parseEvent: AgentEventParser = (line, id) => {
          const end = line.trim().match(/^__OPTIO_RUN_EXIT__:(\d+)$/);
          if (end) {
            processExitCode = Number(end[1]);
            return { entries: [] };
          }
          if (!command) return agentParser(line, id);
          const parsed = parseCommandLine(line, id);
          if (parsed.exitCode !== undefined) exitCode = parsed.exitCode;
          return { entries: parsed.entries };
        };

        // Capture stderr for diagnostics
        let stderrData = "";
        (async () => {
          for await (const chunk of execSession.stderr as AsyncIterable<Buffer>) {
            stderrData += chunk.toString();
          }
        })().catch(() => {});

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

        try {
          for await (const chunk of execSession.stdout as AsyncIterable<Buffer>) {
            const text = chunk.toString();
            allLogs += text;

            const parts = (lineBuf + text).split("\n");
            lineBuf = parts.pop() ?? "";

            for (const line of parts) {
              if (!line.trim()) continue;

              const parsed = parseEvent(line, workflowRunId);
              if (parsed.sessionId && !sessionId) {
                sessionId = parsed.sessionId;
                await db
                  .update(workflowRuns)
                  .set({ sessionId, updatedAt: new Date() })
                  .where(eq(workflowRuns.id, workflowRunId));
                log.info({ sessionId }, "Session ID captured");
              }

              // Close stdin on terminal event so agent exits cleanly
              if (parsed.isTerminal) {
                try {
                  execSession.stdin.end();
                } catch (err) {
                  log.warn({ err }, "Failed to close agent stdin on terminal event");
                }
              }

              // Persist + publish log entries (historical DB + live WS)
              for (const entry of parsed.entries) {
                // Stall detection: meaningful agent events are signs of life.
                activity.mark(entry.type);
                await workflowService.appendWorkflowRunLog({
                  workflowRunId,
                  stream: "stdout",
                  content: entry.content,
                  logType: entry.type,
                  metadata: entry.metadata,
                });
              }
            }
            await activity.maybeFlush();
          }
        } finally {
          if (keepAlive) clearInterval(keepAlive);
        }
        await activity.flush();

        // Flush remaining buffer
        if (lineBuf.trim()) {
          const parsed = parseEvent(lineBuf, workflowRunId);
          for (const entry of parsed.entries) {
            await workflowService.appendWorkflowRunLog({
              workflowRunId,
              stream: "stdout",
              content: entry.content,
              logType: entry.type,
              metadata: entry.metadata,
            });
          }
        }

        if (stderrData) {
          log.warn({ stderrPreview: stderrData.slice(0, 500) }, "Agent stderr output");
        }

        // ── Parse result and update run ───────────────────────────────
        if (processExitCode === undefined)
          throw new Error("Exec stream ended without a process exit receipt");
        const result = command
          ? commandResult(exitCode)
          : getAdapter(workflow.agentRuntime).parseResult(processExitCode, allLogs);

        // Override a nominally-successful result if the agent emitted an auth
        // failure mid-run. Claude CLIs typically catch the 401 internally and
        // exit 0, which would otherwise mark the run as completed despite no
        // useful work being done. (A command's output is its own business.)
        const authDetection = command ? null : detectAuthFailureInLogs(allLogs);
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

        // This attempt's spend is ADDED to the run's — whatever became of
        // the run meanwhile (cancelled, retried): it was spent. Not a state
        // change, so it doesn't touch the reconciler's version.
        // (A command spends nothing.)
        const usage = addUsage(workflowRuns, result);
        if (Object.keys(usage).length > 0) {
          await db.update(workflowRuns).set(usage).where(eq(workflowRuns.id, workflowRunId));
        }

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
                errorMessage:
                  effectiveError ?? (command ? "Command failed" : "Agent execution failed"),
                finishedAt: new Date(),
              },
              { startedAt: attemptStartedAt },
            );
        // The reconciler's decideFailed handles the FAILED→QUEUED retry +
        // exponential backoff; the transition wakes it.
        if (!finished) log.info("Run moved on while the agent ran; its result is not recorded");
        else if (effectiveSuccess) log.info("Workflow run completed");
        else log.warn({ error: effectiveError }, "Workflow run failed");
      } catch (err) {
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
                  { errorMessage: String(err) },
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
                    ? `Execution outcome unknown: ${String(err)}. Inspect before retrying.`
                    : String(err),
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
        if (workflowPodId) {
          await workflowPool.releaseRun(workflowRunId, workflowPodId, attemptStartedAt);
        }
      }
    }),
    {
      ...bullmqOpts,
      concurrency: parseIntEnv("OPTIO_MAX_WORKFLOW_CONCURRENT", 5),
      lockDuration: 600_000, // 10 min lock (workflows can run long)
      stalledInterval: 300_000, // check for stalls every 5 min
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
