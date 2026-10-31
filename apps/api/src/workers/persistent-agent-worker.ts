import { db } from "../db/client.js";
import { runBudgetHold } from "../services/usage-budget-service.js";
// Persistent Agent worker — executes one turn for a Persistent Agent.
//
// Lifecycle per turn:
//   1. Pull pending messages from inbox.
//   2. Render prompt: system prompt + agents.md + (initial prompt on turn 1) +
//      formatted message envelopes.
//   3. Create turn record (held from here on), transition agent
//      IDLE/QUEUED → PROVISIONING → RUNNING.
//   4. Acquire pod via persistent-agent-pool-service (honors lifecycle mode).
//   5. Stream agent output, append logs, capture cost + halt reason.
//   6. Halt the turn record, mark pod idle (lifecycle mode decides whether
//      pod stays warm), transition agent → IDLE.
//   7. On failure: increment consecutive_failures; if past limit → FAILED.
//
// The reconciler handles all subsequent waking — the worker just drives
// the actual turn execution.

import { Worker, Queue } from "bullmq";
import {
  PersistentAgentState,
  PersistentAgentPodLifecycle,
  parseIntEnv,
  formatMessageEnvelope,
  buildSenderId,
  type PersistentAgentMessageEnvelope,
  type PersistentAgentWakeSource,
  describeError,
} from "@optio/shared";
import { eq, and, sql } from "drizzle-orm";
import { persistentAgents } from "../db/schema.js";
import * as paService from "../services/persistent-agent-service.js";
import { issueControllerToken } from "../services/controller-auth.js";
import * as paPool from "../services/persistent-agent-pool-service.js";
import * as podPool from "../services/agent-pod-pool.js";
import { getRuntime } from "../services/container-service.js";
import { publishPersistentAgentEvent } from "../services/event-bus.js";
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
import { plusCost } from "../services/run-usage.js";
import { runHome } from "../utils/harness-config.js";
import { resolvePodSecrets } from "../services/secret-service.js";
import { recordAuthEvent } from "../services/auth-failure-detector.js";
import { getEventParser } from "../services/event-parsers.js";
import { enqueueReconcile } from "../services/reconcile-queue.js";
import { pooledAgentEnv } from "../services/pooled-agent-env.js";
import {
  buildInitialClaudeStreamMessage,
  buildPooledAgentCommand,
} from "../services/pooled-agent-command.js";
import {
  buildAgentEnvironment,
  connectionShellEnv,
} from "../services/agent-environment-service.js";
import { applyGitAccess } from "../services/git-access-env.js";
import { getRepo } from "../services/repo-service.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { logger } from "../logger.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

const bullmqOpts = getBullMQOptions();

export const persistentAgentTurnQueue = new Queue("persistent-agent-turns", {
  ...bullmqOpts,
});

export interface ProcessTurnJobData {
  agentId: string;
  wakeSource: PersistentAgentWakeSource;
}

// ── Prompt assembly ────────────────────────────────────────────────────────

function buildTurnPrompt(args: {
  agent: typeof persistentAgents.$inferSelect;
  isFirstTurn: boolean;
  drainedMessages: {
    senderType: string;
    senderId: string | null;
    senderName: string | null;
    body: string;
    broadcasted: boolean;
    receivedAt: Date;
  }[];
}): string {
  const { agent, isFirstTurn, drainedMessages } = args;
  const sections: string[] = [];

  if (agent.systemPrompt) {
    sections.push("# Your role\n" + agent.systemPrompt);
  }

  if (agent.agentsMd) {
    sections.push("# Operator manual\n" + agent.agentsMd);
  }

  if (isFirstTurn) {
    sections.push("# Initial mission\n" + agent.initialPrompt);
  }

  if (drainedMessages.length > 0) {
    const blocks = drainedMessages.map((m) => {
      const envelope: PersistentAgentMessageEnvelope = {
        version: 1,
        timestamp: m.receivedAt.toISOString(),
        sender: m.senderId ?? `${m.senderType}:unknown`,
        type: m.broadcasted ? "broadcast" : "instruction",
        broadcasted: m.broadcasted,
        body: m.body,
      };
      return formatMessageEnvelope(envelope);
    });
    sections.push(
      `# Inbox (${drainedMessages.length} new message${drainedMessages.length === 1 ? "" : "s"})\n` +
        "Read carefully — these messages contain instructions, requests, or status updates from teammates and users. " +
        "Use the available optio-controller tools for work and agent collaboration, " +
        "or follow your operator manual for other communication. Reply to users in your final response.\n\n" +
        blocks.join("\n\n"),
    );
  } else if (!isFirstTurn) {
    sections.push(
      "# Tick\nNo new messages. Decide whether there's any background work to do, otherwise call wait/exit.",
    );
  }

  return sections.join("\n\n---\n\n");
}

function buildAgentCommand(
  agentRuntime: string,
  env: Record<string, string>,
  maxTurns: number,
): string[] {
  return buildPooledAgentCommand(agentRuntime, env, { maxTurns, label: "persistent agent turn" });
}

// ── Worker ─────────────────────────────────────────────────────────────────

export function startPersistentAgentWorker() {
  const worker = new Worker(
    "persistent-agent-turns",
    instrumentWorkerProcessor("persistent-agent-worker", async (job) => {
      // A re-attach (the reconciler's `reattach` action): the turn is already
      // going in its pod; take it over from where its log rows stop.
      if (job.name === "attach-persistent-agent-turn") {
        await attachTurn(job);
        return;
      }
      const { agentId, wakeSource } = job.data as unknown as ProcessTurnJobData;
      const log = logger.child({ agentId, jobId: job.id, persistentAgent: true });

      // 1. Verify agent is in QUEUED state and claim by transitioning to PROVISIONING.
      const agent = await paService.getPersistentAgentUnscoped(agentId);
      if (!agent) {
        log.warn("Persistent agent not found, skipping job");
        return;
      }
      if (agent.state !== PersistentAgentState.QUEUED) {
        log.info({ state: agent.state }, "Skipping — agent is not in queued state");
        return;
      }
      if (!agent.enabled) {
        log.info("Agent disabled, skipping");
        return;
      }

      const budgetHold = await runBudgetHold("agent", agentId);
      if (budgetHold) {
        await db
          .update(persistentAgents)
          .set({
            lastFailureReason: budgetHold,
            reconcileBackoffUntil: new Date(Date.now() + 60_000),
          })
          .where(eq(persistentAgents.id, agentId));
        await persistentAgentTurnQueue.add(job.name, job.data, {
          jobId: `${agentId}-budget-${Date.now()}`,
          delay: 60_000,
          removeOnComplete: true,
        });
        return;
      }
      await db
        .update(persistentAgents)
        .set({ lastFailureReason: null })
        .where(
          and(
            eq(persistentAgents.id, agentId),
            sql`${persistentAgents.lastFailureReason} LIKE 'Usage budget reached:%'`,
          ),
        );

      const claimed = await paService.transitionPersistentAgentState(
        agentId,
        PersistentAgentState.PROVISIONING,
        agent.updatedAt,
        {},
        "worker_claim",
      );
      if (!claimed) {
        log.info("Failed to claim agent (CAS), reconciler will retry");
        return;
      }

      // Re-fetch to get the new updated_at for downstream CAS.
      const claimedAgent = await paService.getPersistentAgentUnscoped(agentId);
      if (!claimedAgent) return;

      let executionAttempted = false;
      let turn: { id: string; turnNumber: number } | null = null;
      let pod: paPool.PersistentAgentPodHandle | null = null;
      // This job's hold on the turn, from its creation on
      // (run-attachment.ts); the finally lets go of it through `endRunJob`.
      let hold: AttachmentHold | null = null;
      let ended: RunEnd | null = null;

      try {
        // 2. Drain inbox.
        const pending = await paService.listPendingMessages(agentId);
        const isFirstTurn = (claimedAgent.lastTurnAt ?? null) === null;
        const renderedPrompt = buildTurnPrompt({
          agent: claimedAgent,
          isFirstTurn,
          drainedMessages: pending.map((m) => ({
            senderType: m.senderType,
            senderId: m.senderId,
            senderName: m.senderName,
            body: m.body,
            broadcasted: m.broadcasted,
            receivedAt: m.receivedAt,
          })),
        });

        // 3. Create turn record, held by this job from here on. Getting a
        // pod can take minutes: an instance that dies meanwhile leaves a
        // held turn that never started, which the reconciler halts once its
        // lease lapses — the agent wakes again, its messages still pending —
        // where an agent with no turn yet would wait out NO_OPEN_TURN_GRACE_MS.
        turn = await paService.createPersistentAgentTurn({
          agentId,
          wakeSource,
          wakePayload: {
            messageIds: pending.map((m) => m.id),
            isFirstTurn,
            // What this turn runs: an instance that attaches to it later
            // reads its output by this, not by the agent's live definition.
            agentRuntime: claimedAgent.agentRuntime,
          },
          promptUsed: renderedPrompt,
        });

        hold = await beginHold(turnRef(turn.id));

        // 4. Acquire pod (honors lifecycle mode).
        pod = await paPool.acquirePodForAgent(agentId, {
          workspaceId: claimedAgent.workspaceId ?? null,
        });
        await paService.setPersistentAgentTurnPod(turn.id, pod);

        // 5. Build env + invoke agent.
        // Personal agents run with their owner's secrets; organization agents
        // never see anyone's (see services/work-ownership.ts).
        const agentOwnerUserId = claimedAgent.ownerUserId ?? null;
        // A team's agent runs with the team's secrets, never its creator's own.
        const agentTeamId = claimedAgent.ownerTeamId ?? null;
        const team = agentTeamId ? { ownerTeamId: agentTeamId } : {};
        const picked = await resolvePodSecrets(claimedAgent.podSecrets, {
          workspaceId: claimedAgent.workspaceId ?? null,
          ownerUserId: agentOwnerUserId,
          ...team,
        });
        const apiUrl =
          process.env.OPTIO_API_INTERNAL_URL ??
          process.env.OPTIO_API_URL ??
          `http://localhost:${process.env.API_PORT ?? "4000"}`;
        const env: Record<string, string> = {
          ...picked.env,
          // The agent's sign-in and parameters, as a Job run's.
          ...(await pooledAgentEnv(
            claimedAgent,
            renderedPrompt,
            claimedAgent.workspaceId ?? null,
            agentOwnerUserId,
            ...(agentTeamId ? [agentTeamId] : []),
          )),
          OPTIO_PERSISTENT_AGENT_ID: agentId,
          OPTIO_PERSISTENT_AGENT_SLUG: claimedAgent.slug,
          OPTIO_PERSISTENT_AGENT_TURN_ID: turn.id,
          // Legacy HTTP messaging gets a per-turn credential, never the public agent id.
          OPTIO_AGENT_TOKEN: await issueControllerToken({
            kind: "turn",
            id: turn.id,
            workspaceId: claimedAgent.workspaceId ?? null,
            ownerUserId: agentOwnerUserId,
            ...team,
            access: "messages",
          }),
          OPTIO_API_URL: apiUrl,
        };

        // An agent with a repo works in a checkout of it, signed in to git
        // the way repo pods are.
        // (Only one of the agent's own workspace: the checkout signs in with
        // that workspace's git access.)
        const found = claimedAgent.repoId
          ? await getRepo(claimedAgent.repoId).catch(() => null)
          : null;
        const repo =
          found && (found.workspaceId ?? null) === (claimedAgent.workspaceId ?? null)
            ? found
            : null;
        if (repo) {
          env.OPTIO_REPO_URL = repo.repoUrl;
          env.OPTIO_REPO_BRANCH = claimedAgent.branch || repo.defaultBranch;
          await applyGitAccess(env, {
            workspaceId: claimedAgent.workspaceId ?? null,
            repoUrl: repo.repoUrl,
            helper: false,
          });
        }

        // The agent's environment: MCP servers, connections, and skills with
        // its settings applied, and its setup commands — as every pod run gets.
        const environmentInput = {
          repoUrl: repo?.repoUrl ?? null,
          agentType: claimedAgent.agentRuntime,
          workspaceId: claimedAgent.workspaceId ?? null,
          ownerUserId: agentOwnerUserId,
          ...team,
          settings: claimedAgent.settings,
          runId: turn.id,
          controllerRunKind: "turn" as const,
        };
        Object.assign(
          env,
          await buildAgentEnvironment(environmentInput, log),
          // Last: a connection's shell env is the agent's own choice.
          await connectionShellEnv(environmentInput),
        );

        const agentCommand = buildAgentCommand(
          claimedAgent.agentRuntime,
          env,
          claimedAgent.maxTurns,
        );

        // Start the agent under the run protocol: the start exec returns
        // once the supervisor runs; any API instance can attach to the
        // turn's output from here on, and this one does so right away.
        executionAttempted = true;
        const started = await paPool.startTurnInPod(pod, turn.id, agentCommand, env, {
          initialStdin:
            claimedAgent.agentRuntime === "claude-code"
              ? buildInitialClaudeStreamMessage(renderedPrompt)
              : "",
        });
        if (started.output.trim()) {
          log.debug({ setup: started.output.slice(-2000) }, "Turn setup output");
        }
        if (!(await recordRunStarted(hold, { podId: pod.id, pid: started.pid }))) {
          // Requeued while it was set up: the agent is nobody's, and
          // `endRunJob` stops it.
          log.info("The turn moved on while its agent started; stopping the agent");
          return;
        }
        // The turn runs: its messages are its own now (a turn that never
        // started leaves them pending for the next one), and the agent is
        // `running` — which always means a turn some instance can attach to.
        await beginTurn(
          agentId,
          turn.id,
          pending.map((m) => m.id),
        );
        log.info({ pid: started.pid, turnId: turn.id }, "Agent started; attaching");

        ended = await finishTurn({
          agentId,
          turn,
          agent: claimedAgent,
          agentRuntime: claimedAgent.agentRuntime,
          pod: { id: pod.id, handle: podPool.podHandle(pod) },
          log,
          hold,
          claim: { consumedBytes: 0, execState: "started", pid: started.pid },
        });
      } catch (err) {
        // Once its agent streams, an error is this instance's trouble, not
        // the turn's: the turn is left for an attach (run-attachment.ts).
        const afterStart = await onStreamError(hold, log);
        if (afterStart) {
          ended = afterStart;
          log.error(
            { err },
            "Persistent agent worker error while streaming; the turn is left for an attach",
          );
          return;
        }
        log.error({ err }, "Persistent agent worker error");
        if (turn) {
          await paService
            .haltPersistentAgentTurn({
              turnId: turn.id,
              haltReason: "error",
              errorMessage: describeError(err),
            })
            .catch(() => {});
        }
        // Try to recover the agent state to IDLE so the reconciler can decide what to do.
        const after = await paService.getPersistentAgentUnscoped(agentId);
        if (after && after.state !== PersistentAgentState.IDLE) {
          const nextFailures = after.consecutiveFailures + 1;
          const escalate = executionAttempted || nextFailures >= after.consecutiveFailureLimit;
          await paService
            .transitionPersistentAgentState(
              agentId,
              escalate ? PersistentAgentState.FAILED : PersistentAgentState.IDLE,
              after.updatedAt,
              {
                consecutiveFailures: nextFailures,
                lastFailureAt: new Date(),
                lastFailureReason: describeError(err),
              },
              "worker_exception",
            )
            .catch(() => {});
        }
        throw err;
      } finally {
        // Let go of the turn: an agent this job started and left behind (a
        // turn halted by the error path above) is stopped first, then the
        // lease goes (run-attachment.ts).
        await endRunJob(hold, ended, log);
        // A turn this job detached from goes on in its pod: the instance
        // that finishes it marks the pod idle and wakes the reconciler.
        if (ended !== "detached") {
          // Mark pod idle (lifecycle mode decides keep-warm vs reap).
          await paPool.markPodIdle(agentId).catch(() => {});
          // Wake the reconciler so it can decide whether to start another turn
          // (e.g. if more messages arrived while this turn ran).
          await enqueueReconcile(
            { kind: "persistent-agent", id: agentId },
            {
              reason: "turn_finished",
            },
          ).catch(() => {});
        }
      }
    }),
    {
      ...bullmqOpts,
      concurrency: parseIntEnv("OPTIO_MAX_PERSISTENT_AGENT_TURNS_RUNNING", 5),
      // See task-worker: the job lasts as long as this instance streams the
      // turn; recovery is the attach sweep's, not BullMQ's stall re-delivery.
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Persistent agent turn failed");
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Persistent agent turn completed");
  });

  return worker;
}

// Suppress unused-import warnings for items only consumed via type/lazy paths.
void buildSenderId;
void PersistentAgentPodLifecycle;

// ── The run protocol: attaching to a turn's agent and finishing the turn ─────

/** The attachment columns of a turn's row (run-attachment.ts). */
export function turnRef(turnId: string): AttachRef {
  return { kind: "turn", id: turnId };
}

/**
 * A started turn takes its messages (drained into it, so later turns don't
 * see them again) and moves the agent PROVISIONING → RUNNING (CAS). Both
 * idempotent: the instance that attaches to a turn whose starter went away
 * in between does the same.
 */
async function beginTurn(agentId: string, turnId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length > 0) {
    await paService.drainMessagesIntoTurn(agentId, turnId, messageIds);
  }
  const provAgent = await paService.getPersistentAgentUnscoped(agentId);
  if (!provAgent) throw new Error("Agent disappeared during provisioning");
  if (provAgent.state !== PersistentAgentState.PROVISIONING) return;
  await paService.transitionPersistentAgentState(
    agentId,
    PersistentAgentState.RUNNING,
    provAgent.updatedAt,
    {},
    "worker_provisioned",
  );
}

interface FinishTurnInput {
  agentId: string;
  turn: { id: string; turnNumber: number };
  agent: typeof persistentAgents.$inferSelect;
  /** What the turn runs, as its start recorded it (the agent may have been edited since). */
  agentRuntime: string;
  pod: AttachedPod;
  log: typeof logger;
  hold: AttachmentHold;
  /** Where the turn's log rows reach, and whether an earlier holder already recorded its exit. */
  claim: AttachmentClaim;
}

/**
 * Streams a started turn to its end, halts it, and moves the agent on —
 * the one path for the job that started the turn and for a job that
 * attaches to it later. Returns "detached" when this instance stopped
 * streaming without the turn ending (shutdown, or another instance took it).
 */
async function finishTurn(input: FinishTurnInput): Promise<RunEnd> {
  const { agentId, turn, agent, agentRuntime, pod, log, hold } = input;
  const ref = turnRef(turn.id);
  const runtime = getRuntime();
  const runDir = runHome(turn.id).podDir;
  const parseEvent = getEventParser(agentRuntime);
  // Derivations: rebuilt from byte 0 on every attach, never persisted.
  const digest = new RunOutputDigest(agentRuntime);

  const { outcome, sessionId: capturedSessionId } = await streamRun({
    runtime,
    handle: pod.handle,
    ref,
    runDir,
    hold,
    consumedBytes: input.claim.consumedBytes,
    log,
    parse: (line) => parseEvent(line, turn.id),
    derive: (line) => digest.push(line),
    publish: (row) =>
      publishPersistentAgentEvent({
        type: "persistent_agent:log",
        agentId,
        agentSlug: agent.slug,
        turnId: turn.id,
        stream: (row.stream as "stdout" | "stderr") ?? "stdout",
        content: row.content,
        logType: row.logType ?? undefined,
        metadata: row.metadata ?? undefined,
        timestamp: row.timestamp?.toISOString() ?? new Date().toISOString(),
      }),
  });

  if (outcome.kind === "reset") {
    log.info("The turn was reset while its agent ran; leaving it");
    return "reset";
  }
  if (outcome.kind === "taken" || outcome.kind === "detached") {
    log.info({ outcome: outcome.kind }, "Detached from the turn; it continues in its pod");
    return "detached";
  }

  let success: boolean;
  let effectiveError: string | undefined;
  let result: ReturnType<RunOutputDigest["finish"]>["result"] | null = null;
  if (outcome.kind === "lost") {
    const stderrTail = await readRunStderr(runtime, pod.handle, runDir);
    const settledLost = await settleRun(hold);
    if (settledLost === "taken" || settledLost === "reset") return endOfLoss(settledLost);
    success = false;
    effectiveError = withStderr(
      "Execution outcome unknown: the turn's process and output are gone (the pod restarted while it ran). Inspect before resuming.",
      stderrTail,
    );
    log.warn("Turn lost: the pod restarted under the agent");
  } else {
    // 6. Parse result, halt turn, transition agent → IDLE (or FAILED if errored).
    // The agent exited and every line of its output is a log row; its
    // result was read as the output streamed.
    const verdict = digest.finish(outcome.code);
    result = verdict.result;
    success = result.success;
    effectiveError = result.error;
    if (verdict.auth.matched) {
      success = false;
      effectiveError = `Auth failure: ${verdict.auth.excerpt ?? verdict.auth.pattern}`;
      recordAuthEvent(
        "claude",
        verdict.auth.excerpt ?? verdict.auth.pattern ?? "auth_failure",
        "persistent-agent-worker",
      ).catch(() => {});
    }
    // A failed turn says why in its stderr, which its error carries.
    if (!success) {
      effectiveError = withStderr(
        effectiveError ?? "Turn failed",
        await readRunStderr(runtime, pod.handle, runDir),
      );
    }
    // The exit, and the turn's spend on the agent's running total — once,
    // whichever instance gets here (`settleRun` is a CAS on the exit).
    const cost = result.costUsd;
    const settled = await settleRun(hold, {}, async (tx) => {
      if (cost == null) return;
      await tx
        .update(persistentAgents)
        .set({ totalCostUsd: plusCost(persistentAgents.totalCostUsd, String(cost)) })
        .where(eq(persistentAgents.id, agentId));
    });
    if (settled === "taken" || settled === "reset") return endOfLoss(settled);
  }

  await paService.haltPersistentAgentTurn({
    turnId: turn.id,
    haltReason: success ? "natural" : "error",
    errorMessage: success ? null : (effectiveError ?? "Turn failed"),
    costUsd: result?.costUsd != null ? String(result.costUsd) : null,
    cacheReadTokens: result?.cacheReadTokens,
    cacheWriteTokens: result?.cacheWriteTokens,
    costBasis: result?.costBasis,
    modelUsed: result?.model,
    inputTokens: result?.inputTokens ?? null,
    outputTokens: result?.outputTokens ?? null,
    sessionId: capturedSessionId ?? null,
    summary: result?.summary ?? null,
  });

  const after = await paService.getPersistentAgentUnscoped(agentId);
  if (after && after.state === PersistentAgentState.RUNNING) {
    if (success) {
      // RUNNING → IDLE on success, reset failure counter.
      await paService.transitionPersistentAgentState(
        agentId,
        PersistentAgentState.IDLE,
        after.updatedAt,
        {
          consecutiveFailures: 0,
          lastFailureReason: null,
          lastTurnAt: new Date(),
          sessionId: capturedSessionId ?? null,
        },
        "turn_completed",
      );
    } else {
      // Failure path — escalate or recover. A lost turn's outcome is
      // uncertain: a person decides, as for any lost run.
      const nextFailures = after.consecutiveFailures + 1;
      const escalate = outcome.kind === "lost" || nextFailures >= after.consecutiveFailureLimit;
      await paService.transitionPersistentAgentState(
        agentId,
        escalate ? PersistentAgentState.FAILED : PersistentAgentState.IDLE,
        after.updatedAt,
        {
          consecutiveFailures: nextFailures,
          lastFailureAt: new Date(),
          lastFailureReason: effectiveError ?? "Turn failed",
          lastTurnAt: new Date(),
        },
        outcome.kind === "lost"
          ? "turn_lost"
          : escalate
            ? "consecutive_failures_exceeded"
            : "turn_failed",
      );
    }
  } else {
    log.info({ state: after?.state }, "Agent moved on while the turn ran; leaving its state");
  }

  // The turn is over and every byte of its output is a log row: its
  // directory in the pod (output, stdin, the runtime's config) goes.
  if (outcome.kind !== "lost") await removeRunDirectory(runtime, pod.handle, runDir, log);
  await closeAttachment(hold);
  return "finished";
}

/** Halts a turn as an error and fails its agent (when it is still on the turn). */
async function failTurn(
  agentId: string,
  turnId: string,
  message: string,
  trigger: string,
): Promise<void> {
  await paService.haltPersistentAgentTurn({ turnId, haltReason: "error", errorMessage: message });
  const after = await paService.getPersistentAgentUnscoped(agentId);
  if (
    after &&
    (after.state === PersistentAgentState.RUNNING ||
      after.state === PersistentAgentState.PROVISIONING)
  ) {
    await paService.transitionPersistentAgentState(
      agentId,
      PersistentAgentState.FAILED,
      after.updatedAt,
      {
        consecutiveFailures: after.consecutiveFailures + 1,
        lastFailureAt: new Date(),
        lastFailureReason: message,
      },
      trigger,
    );
  }
}

/**
 * An `attach-persistent-agent-turn` job (the reconciler's `reattach`
 * action): take the turn if nobody holds it and finish it from where its
 * log rows stop.
 */
async function attachTurn(job: { id?: string; data: unknown }): Promise<void> {
  const { agentId, turnId } = job.data as { agentId: string; turnId: string };
  const log = logger.child({ agentId, turnId, jobId: job.id, persistentAgent: true, attach: true });
  const [agent, turn] = await Promise.all([
    paService.getPersistentAgentUnscoped(agentId),
    paService.getPersistentAgentTurn(turnId),
  ]);
  if (
    !agent ||
    (agent.state !== PersistentAgentState.RUNNING &&
      agent.state !== PersistentAgentState.PROVISIONING)
  ) {
    log.info({ state: agent?.state }, "Skipping attach — the agent is not running a turn");
    return;
  }
  if (!turn || turn.agentId !== agentId || turn.finishedAt) {
    log.info("Skipping attach — the turn is over");
    return;
  }
  const payload = (turn.wakePayload ?? null) as {
    messageIds?: string[];
    agentRuntime?: string;
  } | null;
  const messageIds = payload?.messageIds ?? [];
  // What the turn runs, as its start recorded it (a turn from before the
  // record: the agent's own runtime).
  const agentRuntime = payload?.agentRuntime ?? agent.agentRuntime;
  let ended: RunEnd | "skipped" = "skipped";
  try {
    ended = await runAttachJob({
      ref: turnRef(turnId),
      log,
      podId: turn.podId ?? null,
      onAttachFailed: (message) => failTurn(agentId, turnId, message, "turn_attach_failed"),
      async onPodGone(detail) {
        const message = `Execution outcome unknown: ${detail}. Inspect before resuming.`;
        await paService.haltPersistentAgentTurn({
          turnId,
          haltReason: "error",
          errorMessage: message,
        });
        const after = await paService.getPersistentAgentUnscoped(agentId);
        if (
          after &&
          (after.state === PersistentAgentState.RUNNING ||
            after.state === PersistentAgentState.PROVISIONING)
        ) {
          await paService.transitionPersistentAgentState(
            agentId,
            PersistentAgentState.FAILED,
            after.updatedAt,
            {
              consecutiveFailures: after.consecutiveFailures + 1,
              lastFailureAt: new Date(),
              lastFailureReason: message,
            },
            "turn_lost",
          );
        }
      },
      async finish(pod, hold, claim) {
        // The instance that started the turn may have gone away before the
        // turn took its messages and the agent moved to `running`.
        await beginTurn(agentId, turnId, messageIds);
        return finishTurn({
          agentId,
          turn: { id: turn.id, turnNumber: turn.turnNumber },
          agent,
          agentRuntime,
          pod,
          log,
          hold,
          claim,
        });
      },
    });
  } catch (err) {
    log.error({ err }, "Attach failed; the turn stays for the next attach");
    throw err;
  } finally {
    if (ended === "finished") {
      // Mark pod idle (lifecycle mode decides keep-warm vs reap) and wake
      // the reconciler for the next turn, as the starting job does.
      await paPool.markPodIdle(agentId).catch(() => {});
      await enqueueReconcile(
        { kind: "persistent-agent", id: agentId },
        { reason: "turn_finished" },
      ).catch(() => {});
    }
  }
}
