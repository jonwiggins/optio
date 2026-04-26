// Persistent Agent worker — executes one turn for a Persistent Agent.
//
// Lifecycle per turn:
//   1. Pull pending messages from inbox.
//   2. Render prompt: system prompt + agents.md + (initial prompt on turn 1) +
//      formatted message envelopes.
//   3. Acquire pod via persistent-agent-pool-service (honors lifecycle mode).
//   4. Create turn record, transition agent IDLE/QUEUED → PROVISIONING → RUNNING.
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
} from "@optio/shared";
import { getAdapter } from "@optio/agent-adapters";
import { persistentAgents } from "../db/schema.js";
import * as paService from "../services/persistent-agent-service.js";
import * as paPool from "../services/persistent-agent-pool-service.js";
import { resolveSecretsForTask, retrieveSecretWithFallback } from "../services/secret-service.js";
import { detectAuthFailureInLogs, recordAuthEvent } from "../services/auth-failure-detector.js";
import { parseClaudeEvent } from "../services/agent-event-parser.js";
import { parseCodexEvent } from "../services/codex-event-parser.js";
import { parseCopilotEvent } from "../services/copilot-event-parser.js";
import { parseOpenCodeEvent } from "../services/opencode-event-parser.js";
import { parseGeminiEvent } from "../services/gemini-event-parser.js";
import { enqueueReconcile } from "../services/reconcile-queue.js";
import { getBullMQConnectionOptions } from "../services/redis-config.js";
import { logger } from "../logger.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

const connectionOpts = getBullMQConnectionOptions();

export const persistentAgentTurnQueue = new Queue("persistent-agent-turns", {
  connection: connectionOpts,
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
        "Respond using the optio-agents MCP server (see operator manual).\n\n" +
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
  switch (agentRuntime) {
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
        `echo "[optio] Running persistent agent turn (Claude Code)..."`,
        `claude --print \\`,
        `  --dangerously-skip-permissions \\`,
        `  --input-format stream-json \\`,
        `  --output-format stream-json \\`,
        `  --verbose \\`,
        `  --max-turns ${maxTurns} \\`,
        `  ${modelFlag}`.trim(),
      ];
    }
    case "codex":
      return [
        `echo "[optio] Running persistent agent turn (Codex)..."`,
        `codex exec --full-auto "$OPTIO_PROMPT" --json`,
      ];
    case "copilot": {
      const modelFlag = env.COPILOT_MODEL ? ` --model ${JSON.stringify(env.COPILOT_MODEL)}` : "";
      return [
        `echo "[optio] Running persistent agent turn (Copilot)..."`,
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
        `echo "[optio] Running persistent agent turn (OpenCode)..."`,
        `opencode run --format json${modelFlag} "$OPTIO_PROMPT"`,
      ];
    }
    case "gemini": {
      const geminiModelFlag = env.OPTIO_GEMINI_MODEL
        ? ` -m ${JSON.stringify(env.OPTIO_GEMINI_MODEL)}`
        : "";
      return [
        `echo "[optio] Running persistent agent turn (Gemini)..."`,
        `gemini ${geminiModelFlag} -p "$OPTIO_PROMPT"`,
      ];
    }
    default:
      return [`echo "Unknown agent runtime: ${agentRuntime}"`, `exit 1`];
  }
}

function buildInitialStreamMessage(prompt: string): string {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }) + "\n"
  );
}

function pickEventParser(agentRuntime: string) {
  switch (agentRuntime) {
    case "codex":
      return parseCodexEvent;
    case "copilot":
      return parseCopilotEvent;
    case "opencode":
      return parseOpenCodeEvent;
    case "gemini":
      return parseGeminiEvent;
    default:
      return parseClaudeEvent;
  }
}

// ── Worker ─────────────────────────────────────────────────────────────────

export function startPersistentAgentWorker() {
  const worker = new Worker(
    "persistent-agent-turns",
    instrumentWorkerProcessor("persistent-agent-worker", async (job) => {
      const { agentId, wakeSource } = job.data as unknown as ProcessTurnJobData;
      const log = logger.child({ agentId, jobId: job.id, persistentAgent: true });

      // 1. Verify agent is in QUEUED state and claim by transitioning to PROVISIONING.
      const agent = await paService.getPersistentAgent(agentId);
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
      const claimedAgent = await paService.getPersistentAgent(agentId);
      if (!claimedAgent) return;

      let turn: { id: string; turnNumber: number } | null = null;
      let pod: paPool.PersistentAgentPodHandle | null = null;
      let nextStateOnSuccess: PersistentAgentState = PersistentAgentState.IDLE;

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

        // 3. Acquire pod (honors lifecycle mode).
        pod = await paPool.acquirePodForAgent(agentId, {
          workspaceId: claimedAgent.workspaceId ?? null,
        });

        // 4. Create turn record.
        turn = await paService.createPersistentAgentTurn({
          agentId,
          wakeSource,
          wakePayload: {
            messageIds: pending.map((m) => m.id),
            isFirstTurn,
          },
          promptUsed: renderedPrompt,
          podId: pod.id,
          podName: pod.podName,
        });

        // Drain messages into the turn so future turns don't see them again.
        if (pending.length > 0) {
          await paService.drainMessagesIntoTurn(
            agentId,
            turn.id,
            pending.map((m) => m.id),
          );
        }

        // Transition PROVISIONING → RUNNING (CAS).
        const provAgent = await paService.getPersistentAgent(agentId);
        if (!provAgent) throw new Error("Agent disappeared during provisioning");
        await paService.transitionPersistentAgentState(
          agentId,
          PersistentAgentState.RUNNING,
          provAgent.updatedAt,
          {},
          "worker_provisioned",
        );

        // 5. Build env + invoke agent.
        const adapter = getAdapter(claimedAgent.agentRuntime);
        const resolvedSecrets = await resolveSecretsForTask(
          adapter.validateSecrets([]).missing,
          "",
          claimedAgent.workspaceId ?? null,
          claimedAgent.createdBy ?? null,
        );
        const claudeAuthMode =
          ((await retrieveSecretWithFallback(
            "CLAUDE_AUTH_MODE",
            "global",
            claimedAgent.workspaceId ?? null,
          ).catch(() => null)) as string | null) ?? "api-key";

        const apiUrl = process.env.PUBLIC_URL || process.env.OPTIO_API_URL || "";
        const env: Record<string, string> = {
          ...resolvedSecrets,
          OPTIO_PROMPT: renderedPrompt,
          OPTIO_PERSISTENT_AGENT_ID: agentId,
          OPTIO_PERSISTENT_AGENT_SLUG: claimedAgent.slug,
          OPTIO_PERSISTENT_AGENT_TURN_ID: turn.id,
          OPTIO_AGENT_TYPE: claimedAgent.agentRuntime,
          OPTIO_AUTH_MODE: claudeAuthMode,
          // Per-agent bearer token used by the inter-agent HTTP API.
          // Documented in the agent's `agents.md` operator manual.
          OPTIO_AGENT_TOKEN: agentId,
          OPTIO_API_URL: apiUrl,
        };
        if (claimedAgent.model) env.OPTIO_CLAUDE_MODEL = claimedAgent.model;

        if (claudeAuthMode === "api-key") {
          const apiKey = await retrieveSecretWithFallback(
            "ANTHROPIC_API_KEY",
            "global",
            claimedAgent.workspaceId ?? null,
            claimedAgent.createdBy ?? null,
          ).catch(() => null);
          if (apiKey) env.ANTHROPIC_API_KEY = apiKey as string;
        } else if (claudeAuthMode === "oauth-token") {
          const tok = await retrieveSecretWithFallback(
            "CLAUDE_CODE_OAUTH_TOKEN",
            "global",
            claimedAgent.workspaceId ?? null,
            claimedAgent.createdBy ?? null,
          ).catch(() => null);
          if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok as string;
        }

        const agentCommand = buildAgentCommand(
          claimedAgent.agentRuntime,
          env,
          claimedAgent.maxTurns,
        );

        const execSession = await paPool.execTurnInPod(pod, turn.id, agentCommand, env);

        if (claimedAgent.agentRuntime === "claude-code") {
          try {
            execSession.stdin.write(buildInitialStreamMessage(renderedPrompt));
          } catch (err) {
            log.warn({ err }, "Failed to write initial prompt");
          }
        }

        // Stream output.
        const parseEvent = pickEventParser(claimedAgent.agentRuntime);
        let allLogs = "";
        let lineBuf = "";
        let stderrData = "";
        let capturedSessionId: string | undefined;

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
            const parsed = parseEvent(line, turn.id);
            if (parsed.sessionId && !capturedSessionId) {
              capturedSessionId = parsed.sessionId;
            }
            if (parsed.isTerminal) {
              try {
                execSession.stdin.end();
              } catch {
                // already closed
              }
            }
            for (const entry of parsed.entries) {
              await paService.appendPersistentAgentLog({
                turnId: turn.id,
                agentId,
                stream: "stdout",
                content: entry.content,
                logType: entry.type,
                metadata: entry.metadata,
              });
            }
          }
        }
        if (lineBuf.trim()) {
          const parsed = parseEvent(lineBuf, turn.id);
          for (const entry of parsed.entries) {
            await paService.appendPersistentAgentLog({
              turnId: turn.id,
              agentId,
              stream: "stdout",
              content: entry.content,
              logType: entry.type,
              metadata: entry.metadata,
            });
          }
        }

        if (stderrData) {
          log.warn({ stderrPreview: stderrData.slice(0, 500) }, "agent stderr");
        }

        // 6. Parse result, halt turn, transition agent → IDLE (or FAILED if errored).
        const result = adapter.parseResult(0, allLogs);
        const authDetection = detectAuthFailureInLogs(allLogs);
        let success = result.success;
        let effectiveError = result.error;
        if (authDetection.matched) {
          success = false;
          effectiveError = `Auth failure: ${authDetection.excerpt ?? authDetection.pattern}`;
          recordAuthEvent(
            "claude",
            authDetection.excerpt ?? authDetection.pattern ?? "auth_failure",
            "persistent-agent-worker",
          ).catch(() => {});
        }

        await paService.haltPersistentAgentTurn({
          turnId: turn.id,
          haltReason: success ? "natural" : "error",
          errorMessage: success ? null : (effectiveError ?? "Turn failed"),
          costUsd: result.costUsd != null ? String(result.costUsd) : null,
          inputTokens: result.inputTokens ?? null,
          outputTokens: result.outputTokens ?? null,
          sessionId: capturedSessionId ?? null,
          summary: result.summary ?? null,
        });

        if (result.costUsd != null) {
          await paService.addToTotalCost(agentId, String(result.costUsd));
        }

        if (success) {
          // RUNNING → IDLE on success, reset failure counter.
          const after = await paService.getPersistentAgent(agentId);
          if (after) {
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
          }
        } else {
          // Failure path — escalate or recover.
          const after = await paService.getPersistentAgent(agentId);
          if (after) {
            const nextFailures = after.consecutiveFailures + 1;
            const escalate = nextFailures >= after.consecutiveFailureLimit;
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
              escalate ? "consecutive_failures_exceeded" : "turn_failed",
            );
            nextStateOnSuccess = escalate ? PersistentAgentState.FAILED : PersistentAgentState.IDLE;
          }
        }
      } catch (err) {
        log.error({ err }, "Persistent agent worker error");
        if (turn) {
          await paService
            .haltPersistentAgentTurn({
              turnId: turn.id,
              haltReason: "error",
              errorMessage: String(err),
            })
            .catch(() => {});
        }
        // Try to recover the agent state to IDLE so the reconciler can decide what to do.
        const after = await paService.getPersistentAgent(agentId);
        if (after && after.state !== PersistentAgentState.IDLE) {
          const nextFailures = after.consecutiveFailures + 1;
          const escalate = nextFailures >= after.consecutiveFailureLimit;
          await paService
            .transitionPersistentAgentState(
              agentId,
              escalate ? PersistentAgentState.FAILED : PersistentAgentState.IDLE,
              after.updatedAt,
              {
                consecutiveFailures: nextFailures,
                lastFailureAt: new Date(),
                lastFailureReason: String(err),
              },
              "worker_exception",
            )
            .catch(() => {});
        }
        throw err;
      } finally {
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
        // Suppress unused-var warning: nextStateOnSuccess is informational
        // (worker logs only). Keep the assignment for easier future telemetry.
        void nextStateOnSuccess;
      }
    }),
    {
      connection: connectionOpts,
      concurrency: parseIntEnv("OPTIO_MAX_PERSISTENT_AGENT_TURNS_RUNNING", 5),
      lockDuration: 600_000,
      stalledInterval: 300_000,
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
