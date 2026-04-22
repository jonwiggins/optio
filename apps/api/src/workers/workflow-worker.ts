import { Worker, Queue } from "bullmq";
import {
  WorkflowRunState,
  canTransitionWorkflowRun,
  DEFAULT_MAX_TURNS_CODING,
  parseIntEnv,
} from "@optio/shared";
import { getAdapter } from "@optio/agent-adapters";
import { parseClaudeEvent } from "../services/agent-event-parser.js";
import { parseCodexEvent } from "../services/codex-event-parser.js";
import { parseCopilotEvent } from "../services/copilot-event-parser.js";
import { parseOpenCodeEvent } from "../services/opencode-event-parser.js";
import { parseGeminiEvent } from "../services/gemini-event-parser.js";
import { db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import * as workflowService from "../services/workflow-service.js";
import * as workflowPool from "../services/workflow-pool-service.js";
import { publishWorkflowRunEvent } from "../services/event-bus.js";
import { enqueueWebhookEvent } from "./webhook-worker.js";
import type { WebhookEvent } from "../services/webhook-service.js";
import { resolveSecretsForTask, retrieveSecretWithFallback } from "../services/secret-service.js";
import { detectAuthFailureInLogs, recordAuthEvent } from "../services/auth-failure-detector.js";
import { logger } from "../logger.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

import { getBullMQConnectionOptions } from "../services/redis-config.js";

const connectionOpts = getBullMQConnectionOptions();

export const workflowRunQueue = new Queue("workflow-runs", { connection: connectionOpts });

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
 * Build the agent command for a workflow run. Similar to task-worker's
 * buildAgentCommand but simplified — no resume, no review mode.
 */
export function buildWorkflowAgentCommand(
  agentType: string,
  env: Record<string, string>,
  opts?: { maxTurns?: number },
): string[] {
  const maxTurns = opts?.maxTurns ?? DEFAULT_MAX_TURNS_CODING;

  switch (agentType) {
    case "claude-code": {
      const authSetup =
        env.OPTIO_AUTH_MODE === "max-subscription"
          ? [
              `if curl -sf "${env.OPTIO_API_URL}/api/auth/claude-token" > /dev/null 2>&1; then echo "[optio] Token proxy OK"; fi`,
              `unset ANTHROPIC_API_KEY 2>/dev/null || true`,
            ]
          : [];

      const modelName = env.OPTIO_CLAUDE_MODEL;
      const ctxWindow = env.OPTIO_CLAUDE_CONTEXT_WINDOW;
      let modelFlag = "";
      if (modelName) {
        const ctx = ctxWindow === "1m" ? "[1m]" : "";
        modelFlag = `--model ${modelName}${ctx}`;
      }

      return [
        ...authSetup,
        `echo "[optio] Running workflow agent (Claude Code)..."`,
        `claude --print \\`,
        `  --dangerously-skip-permissions \\`,
        `  --input-format stream-json \\`,
        `  --output-format stream-json \\`,
        `  --verbose \\`,
        `  --max-turns ${maxTurns} \\`,
        `  ${modelFlag}`.trim(),
      ];
    }
    case "codex": {
      return [
        `echo "[optio] Running workflow agent (Codex)..."`,
        `codex exec --full-auto "$OPTIO_PROMPT" --json`,
      ];
    }
    case "copilot": {
      const modelFlag = env.COPILOT_MODEL ? ` --model ${JSON.stringify(env.COPILOT_MODEL)}` : "";
      return [
        `echo "[optio] Running workflow agent (Copilot)..."`,
        `copilot --autopilot --yolo --max-autopilot-continues ${maxTurns} \\`,
        `  --output-format json --no-ask-user${modelFlag} \\`,
        `  -p "$OPTIO_PROMPT"`,
      ];
    }
    case "opencode": {
      const modelFlag = env.OPTIO_OPENCODE_MODEL
        ? ` --model ${JSON.stringify(env.OPTIO_OPENCODE_MODEL)}`
        : "";
      return [
        `echo "[optio] Running workflow agent (OpenCode)..."`,
        `opencode run --format json${modelFlag} "$OPTIO_PROMPT"`,
      ];
    }
    case "gemini": {
      const geminiModelFlag = env.OPTIO_GEMINI_MODEL
        ? ` -m ${JSON.stringify(env.OPTIO_GEMINI_MODEL)}`
        : "";
      return [
        `echo "[optio] Running workflow agent (Gemini)..."`,
        `gemini ${geminiModelFlag} -p "$OPTIO_PROMPT"`,
      ];
    }
    default:
      return [`echo "Unknown agent type: ${agentType}"`, `exit 1`];
  }
}

/**
 * Build the initial stdin message for Claude Code's stream-json input format.
 */
function buildInitialStreamMessage(prompt: string): string {
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

// ── State transition helpers ───────────────────────────────────────────────────

async function transitionRun(
  runId: string,
  workflowId: string,
  currentState: WorkflowRunState,
  newState: WorkflowRunState,
  fields?: Record<string, unknown>,
): Promise<boolean> {
  if (!canTransitionWorkflowRun(currentState, newState)) {
    logger.warn(
      { runId, from: currentState, to: newState },
      "Invalid workflow run state transition",
    );
    return false;
  }

  await db
    .update(workflowRuns)
    .set({
      state: newState,
      updatedAt: new Date(),
      ...fields,
    })
    .where(eq(workflowRuns.id, runId));

  await publishWorkflowRunEvent({
    type: "workflow_run:state_changed",
    workflowRunId: runId,
    workflowId,
    fromState: currentState,
    toState: newState,
    timestamp: new Date().toISOString(),
  });

  // Fire outbound webhook for relevant state transitions
  const webhookEventMap: Partial<Record<WorkflowRunState, WebhookEvent>> = {
    [WorkflowRunState.RUNNING]: "workflow_run.started",
    [WorkflowRunState.COMPLETED]: "workflow_run.completed",
    [WorkflowRunState.FAILED]: "workflow_run.failed",
  };
  const webhookEvent = webhookEventMap[newState];
  if (webhookEvent) {
    fireWorkflowRunWebhook(runId, workflowId, webhookEvent, currentState).catch((err) =>
      logger.warn({ err, runId, event: webhookEvent }, "Failed to enqueue workflow run webhook"),
    );
  }

  // Wake the reconciler so it observes the new state on the next pass.
  import("../services/reconcile-queue.js")
    .then(({ enqueueReconcile }) =>
      enqueueReconcile(
        { kind: "standalone", id: runId },
        { reason: `transition:${currentState}->${newState}` },
      ),
    )
    .catch((err) => logger.warn({ err, runId }, "Failed to enqueue reconcile"));

  return true;
}

/**
 * Build the webhook payload for a workflow run event and enqueue delivery.
 * Fetches the current run + workflow to produce a self-contained payload.
 */
async function fireWorkflowRunWebhook(
  runId: string,
  workflowId: string,
  event: WebhookEvent,
  fromState: WorkflowRunState,
): Promise<void> {
  const [run, workflow] = await Promise.all([
    workflowService.getWorkflowRun(runId),
    workflowService.getWorkflow(workflowId),
  ]);
  if (!run || !workflow) return;

  const durationMs =
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : run.startedAt
        ? Date.now() - new Date(run.startedAt).getTime()
        : undefined;

  await enqueueWebhookEvent(event, {
    runId: run.id,
    workflowId: workflow.id,
    workflowName: workflow.name,
    state: run.state,
    fromState,
    params: run.params ?? null,
    output: run.output ?? null,
    costUsd: run.costUsd ?? undefined,
    inputTokens: run.inputTokens ?? undefined,
    outputTokens: run.outputTokens ?? undefined,
    modelUsed: run.modelUsed ?? undefined,
    errorMessage: run.errorMessage ?? undefined,
    retryCount: run.retryCount,
    durationMs,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
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
          await transitionRun(
            workflowRunId,
            run.workflowId,
            WorkflowRunState.QUEUED,
            WorkflowRunState.FAILED,
            {
              errorMessage: "Workflow is disabled",
            },
          );
          return;
        }

        // ── Concurrency check ─────────────────────────────────────────
        const claimed = await withClaimLock(async () => {
          // Global workflow concurrency
          const globalMax = parseIntEnv("OPTIO_MAX_WORKFLOW_CONCURRENT", 5);
          const allRuns = await db
            .select()
            .from(workflowRuns)
            .where(eq(workflowRuns.state, WorkflowRunState.RUNNING));
          if (allRuns.length >= globalMax) {
            log.info(
              { activeCount: allRuns.length, globalMax },
              "Global workflow concurrency saturated",
            );
            return false;
          }

          // Per-workflow concurrency
          const workflowActiveRuns = allRuns.filter((r) => r.workflowId === workflow.id);
          if (workflowActiveRuns.length >= workflow.maxConcurrent) {
            log.info(
              { activeCount: workflowActiveRuns.length, max: workflow.maxConcurrent },
              "Per-workflow concurrency saturated",
            );
            return false;
          }

          // Claim: transition to running
          const transitioned = await transitionRun(
            workflowRunId,
            workflow.id,
            WorkflowRunState.QUEUED,
            WorkflowRunState.RUNNING,
            { startedAt: new Date() },
          );
          return transitioned;
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
        log.info("Workflow run claimed, provisioning pod");

        // ── Render prompt ─────────────────────────────────────────────
        const renderedPrompt = renderWorkflowPrompt(
          workflow.promptTemplate,
          run.params as Record<string, unknown> | null,
        );

        // ── Resolve secrets ───────────────────────────────────────────
        const workspaceId = workflow.workspaceId ?? null;
        const workflowUserId = workflow.createdBy ?? null;
        const adapter = getAdapter(workflow.agentRuntime);
        const resolvedSecrets = await resolveSecretsForTask(
          adapter.validateSecrets([]).missing,
          "",
          workspaceId,
          workflowUserId,
        );

        // Resolve auth mode for the agent runtime
        const claudeAuthMode =
          ((await retrieveSecretWithFallback("CLAUDE_AUTH_MODE", "global", workspaceId).catch(
            () => null,
          )) as any) ?? "api-key";

        // Build env vars
        const env: Record<string, string> = {
          ...resolvedSecrets,
          OPTIO_PROMPT: renderedPrompt,
          OPTIO_WORKFLOW_RUN_ID: workflowRunId,
          OPTIO_AGENT_TYPE: workflow.agentRuntime,
          OPTIO_AUTH_MODE: claudeAuthMode,
        };

        // Inject model config
        if (workflow.model) {
          env.OPTIO_CLAUDE_MODEL = workflow.model;
        }

        // For api-key mode, resolve the API key
        if (claudeAuthMode === "api-key") {
          const apiKey = await retrieveSecretWithFallback(
            "ANTHROPIC_API_KEY",
            "global",
            workspaceId,
            workflowUserId,
          ).catch(() => null);
          if (apiKey) env.ANTHROPIC_API_KEY = apiKey as string;
        }

        // For oauth-token mode, resolve the OAuth token
        if (claudeAuthMode === "oauth-token") {
          const oauthToken = await retrieveSecretWithFallback(
            "CLAUDE_CODE_OAUTH_TOKEN",
            "global",
            workspaceId,
            workflowUserId,
          ).catch(() => null);
          if (oauthToken) {
            env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken as string;
          } else {
            throw new Error(
              "OAuth token mode selected but no CLAUDE_CODE_OAUTH_TOKEN secret found",
            );
          }
        }

        // For max-subscription mode, fetch from auth service
        if (claudeAuthMode === "max-subscription") {
          const { getClaudeAuthToken } = await import("../services/auth-service.js");
          const authResult = getClaudeAuthToken();
          if (authResult.available && authResult.token) {
            env.CLAUDE_CODE_OAUTH_TOKEN = authResult.token;
          } else {
            throw new Error(
              `Max subscription auth failed: ${authResult.error ?? "Token not available"}`,
            );
          }
        }

        // ── Provision pod (shared across runs within the workflow) ────
        const envSpec = workflow.environmentSpec as Record<string, string> | null;
        const pod = await workflowPool.getOrCreateWorkflowPod(workflow.id, {
          // Same-pod retry affinity — prefer the pod the previous attempt used.
          preferredPodId: run.lastPodId ?? undefined,
          maxAgentsPerPod: workflow.maxAgentsPerPod,
          maxPodInstances: workflow.maxPodInstances,
          workspaceId,
          cpuRequest: envSpec?.cpuRequest ?? null,
          cpuLimit: envSpec?.cpuLimit ?? null,
          memoryRequest: envSpec?.memoryRequest ?? null,
          memoryLimit: envSpec?.memoryLimit ?? null,
        });
        workflowPodId = pod.id;

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

        // ── Build and execute agent command ────────────────────────────
        const agentCommand = buildWorkflowAgentCommand(workflow.agentRuntime, env, {
          maxTurns: workflow.maxTurns ?? undefined,
        });

        const execSession = await workflowPool.execRunInPod(pod, workflowRunId, agentCommand, env);

        // For claude-code, deliver prompt via stdin (stream-json mode)
        if (workflow.agentRuntime === "claude-code") {
          try {
            execSession.stdin.write(buildInitialStreamMessage(renderedPrompt));
          } catch (err) {
            log.warn({ err }, "Failed to write initial prompt to agent stdin");
          }
        }

        // ── Stream stdout with NDJSON parsing ─────────────────────────
        let allLogs = "";
        let sessionId: string | undefined;
        let lineBuf = "";

        // Pick the right event parser for the agent type
        const parseEvent = (line: string, id: string) => {
          switch (workflow.agentRuntime) {
            case "codex":
              return parseCodexEvent(line, id);
            case "copilot":
              return parseCopilotEvent(line, id);
            case "opencode":
              return parseOpenCodeEvent(line, id);
            case "gemini":
              return parseGeminiEvent(line, id);
            default:
              return parseClaudeEvent(line, id);
          }
        };

        // Capture stderr for diagnostics
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
              await workflowService.appendWorkflowRunLog({
                workflowRunId,
                stream: "stdout",
                content: entry.content,
                logType: entry.type,
                metadata: entry.metadata,
              });
            }
          }
        }

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
        const result = adapter.parseResult(0, allLogs);

        // Override a nominally-successful result if the agent emitted an auth
        // failure mid-run. Claude CLIs typically catch the 401 internally and
        // exit 0, which would otherwise mark the run as completed despite no
        // useful work being done.
        const authDetection = detectAuthFailureInLogs(allLogs);
        let effectiveSuccess = result.success;
        let effectiveError = result.error;
        if (authDetection.matched) {
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

        const costFields: Record<string, unknown> = {};
        if (result.costUsd != null) costFields.costUsd = String(result.costUsd);
        if (result.inputTokens != null) costFields.inputTokens = result.inputTokens;
        if (result.outputTokens != null) costFields.outputTokens = result.outputTokens;
        if (result.model) costFields.modelUsed = result.model;

        if (effectiveSuccess) {
          await transitionRun(
            workflowRunId,
            workflow.id,
            WorkflowRunState.RUNNING,
            WorkflowRunState.COMPLETED,
            {
              ...costFields,
              output: { summary: result.summary },
              finishedAt: new Date(),
            },
          );
          log.info("Workflow run completed");
        } else {
          await transitionRun(
            workflowRunId,
            workflow.id,
            WorkflowRunState.RUNNING,
            WorkflowRunState.FAILED,
            {
              ...costFields,
              errorMessage: effectiveError ?? "Agent execution failed",
              finishedAt: new Date(),
            },
          );
          log.warn({ error: effectiveError }, "Workflow run failed");
          // The reconciler's decideFailed handles the FAILED→QUEUED retry +
          // exponential backoff. transitionRun above wakes it.
        }
      } catch (err) {
        log.error({ err }, "Workflow worker error");
        try {
          const currentRun = await workflowService.getWorkflowRun(workflowRunId);
          if (currentRun && currentRun.state !== WorkflowRunState.COMPLETED) {
            const fromState = currentRun.state as WorkflowRunState;

            // Provisioning retry for recoverable errors
            if (fromState === WorkflowRunState.RUNNING) {
              const MAX_PROVISIONING_RETRIES = 3;
              if (provisioningRetryCount < MAX_PROVISIONING_RETRIES) {
                log.warn(
                  { provisioningRetryCount: provisioningRetryCount + 1 },
                  "Provisioning error, re-queuing",
                );
                await transitionRun(
                  workflowRunId,
                  currentRun.workflowId,
                  fromState,
                  WorkflowRunState.FAILED,
                  {
                    errorMessage: String(err),
                  },
                );
                await transitionRun(
                  workflowRunId,
                  currentRun.workflowId,
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

            // Terminal failure
            if (canTransitionWorkflowRun(fromState, WorkflowRunState.FAILED)) {
              await transitionRun(
                workflowRunId,
                currentRun.workflowId,
                fromState,
                WorkflowRunState.FAILED,
                {
                  errorMessage: String(err),
                  finishedAt: new Date(),
                },
              );
            }
          }
        } catch {
          // May fail if already terminal
        }
        throw err;
      } finally {
        // Release the pool slot so activeRunCount reflects only live runs.
        // Clearing pod_id on the run keeps reconcileActiveRunCounts accurate
        // if the worker later crashes; lastPodId is preserved for retry affinity.
        if (workflowPodId) {
          await workflowPool.releaseRun(workflowPodId).catch(() => {});
          await db
            .update(workflowRuns)
            .set({ podId: null, updatedAt: new Date() })
            .where(eq(workflowRuns.id, workflowRunId))
            .catch(() => {});
        }
      }
    }),
    {
      connection: connectionOpts,
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
