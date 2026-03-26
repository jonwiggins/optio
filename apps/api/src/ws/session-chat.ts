import type { FastifyInstance } from "fastify";
import { getRuntime } from "../services/container-service.js";
import { getSession } from "../services/interactive-session-service.js";
import { db } from "../db/client.js";
import { repoPods, repos, interactiveSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { parseClaudeEvent } from "../services/agent-event-parser.js";
import { publishSessionEvent } from "../services/event-bus.js";
import type { ExecSession } from "@optio/shared";

/**
 * Session chat WebSocket handler.
 *
 * Launches a long-running `claude` process inside the pod's session worktree
 * and pipes stdin/stdout through the WebSocket using structured JSON messages.
 *
 * Client → Server messages:
 *   { type: "message", content: string }          — send a prompt to claude
 *   { type: "interrupt" }                         — SIGINT the current response
 *   { type: "set_model", model: string }          — change model for next prompt
 *
 * Server → Client messages:
 *   { type: "chat_event", event: AgentLogEntry }  — parsed agent event
 *   { type: "cost_update", costUsd: number }      — cumulative cost update
 *   { type: "status", status: string }            — "ready" | "thinking" | "idle" | "error"
 *   { type: "error", message: string }            — error message
 */
export async function sessionChatWs(app: FastifyInstance) {
  app.get("/ws/sessions/:sessionId/chat", { websocket: true }, async (socket, req) => {
    const { sessionId } = req.params as { sessionId: string };
    const log = logger.child({ sessionId, ws: "session-chat" });

    const session = await getSession(sessionId);
    if (!session) {
      socket.send(JSON.stringify({ type: "error", message: "Session not found" }));
      socket.close();
      return;
    }

    if (session.state !== "active") {
      socket.send(JSON.stringify({ type: "error", message: "Session is not active" }));
      socket.close();
      return;
    }

    if (!session.podId) {
      socket.send(JSON.stringify({ type: "error", message: "Session has no pod assigned" }));
      socket.close();
      return;
    }

    // Get pod info
    const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, session.podId));
    if (!pod || !pod.podName) {
      socket.send(JSON.stringify({ type: "error", message: "Pod not found or not ready" }));
      socket.close();
      return;
    }

    // Get repo config for model defaults
    const [repoConfig] = await db.select().from(repos).where(eq(repos.repoUrl, session.repoUrl));
    let currentModel = repoConfig?.claudeModel ?? "sonnet";

    const rt = getRuntime();
    const handle = { id: pod.podId ?? pod.podName, name: pod.podName };
    const worktreePath = session.worktreePath ?? "/workspace/repo";

    let execSession: ExecSession | null = null;
    let cumulativeCost = 0;
    let isProcessing = false;
    let outputBuffer = "";

    // Resolve auth env vars for the claude process
    const authEnv = await buildAuthEnv(log);

    const send = (msg: Record<string, unknown>) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Send initial status with model info
    send({
      type: "status",
      status: "ready",
      model: currentModel,
      costUsd: cumulativeCost,
    });

    /**
     * Execute a single claude prompt in the pod worktree.
     * Uses `claude -p` in one-shot mode with stream-json output.
     * Each message from the user spawns a new exec; we stream events back.
     */
    const runPrompt = async (prompt: string) => {
      if (isProcessing) {
        send({ type: "error", message: "Agent is already processing a request" });
        return;
      }

      isProcessing = true;
      send({ type: "status", status: "thinking" });

      // Build the claude command
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const modelFlag = currentModel ? `--model ${currentModel}` : "";

      const script = [
        "set -e",
        // Wait for repo to be ready
        "for i in $(seq 1 30); do [ -f /workspace/.ready ] && break; sleep 1; done",
        '[ -f /workspace/.ready ] || { echo "Repo not ready"; exit 1; }',
        `cd "${worktreePath}"`,
        // Set auth env vars
        ...Object.entries(authEnv).map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`),
        // Run claude in one-shot prompt mode with streaming JSON output
        `claude -p '${escapedPrompt}' ${modelFlag} --output-format stream-json --verbose --dangerously-skip-permissions 2>&1 || true`,
      ].join("\n");

      try {
        execSession = await rt.exec(handle, ["bash", "-c", script], { tty: false });

        execSession.stdout.on("data", (chunk: Buffer) => {
          outputBuffer += chunk.toString("utf-8");

          // Process complete lines
          const lines = outputBuffer.split("\n");
          outputBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const { entries } = parseClaudeEvent(line, sessionId);
            for (const entry of entries) {
              send({ type: "chat_event", event: entry });

              // Extract cost from result events
              if (entry.metadata?.cost && typeof entry.metadata.cost === "number") {
                cumulativeCost += entry.metadata.cost;
                send({ type: "cost_update", costUsd: cumulativeCost });

                // Update session cost in DB
                updateSessionCost(sessionId, cumulativeCost).catch((err) => {
                  log.warn({ err }, "Failed to update session cost");
                });
              }
            }
          }
        });

        execSession.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8").trim();
          if (text) {
            send({
              type: "chat_event",
              event: {
                taskId: sessionId,
                timestamp: new Date().toISOString(),
                type: "error",
                content: text,
              },
            });
          }
        });

        // Wait for the exec to finish
        await new Promise<void>((resolve) => {
          execSession!.stdout.on("end", () => {
            // Process any remaining buffer
            if (outputBuffer.trim()) {
              const { entries } = parseClaudeEvent(outputBuffer, sessionId);
              for (const entry of entries) {
                send({ type: "chat_event", event: entry });
              }
              outputBuffer = "";
            }
            resolve();
          });
        });
      } catch (err) {
        log.error({ err }, "Failed to run claude prompt in session");
        send({ type: "error", message: "Failed to execute agent prompt" });
      } finally {
        isProcessing = false;
        execSession = null;
        send({ type: "status", status: "idle" });
      }
    };

    // Handle incoming messages from the client
    socket.on("message", (data: Buffer | string) => {
      const str = typeof data === "string" ? data : data.toString("utf-8");

      let msg: { type: string; content?: string; model?: string };
      try {
        msg = JSON.parse(str);
      } catch {
        send({ type: "error", message: "Invalid JSON message" });
        return;
      }

      switch (msg.type) {
        case "message":
          if (!msg.content?.trim()) {
            send({ type: "error", message: "Empty message" });
            return;
          }
          runPrompt(msg.content).catch((err) => {
            log.error({ err }, "Prompt execution failed");
            send({ type: "error", message: "Prompt failed" });
          });
          break;

        case "interrupt":
          if (execSession) {
            log.info("Interrupting agent process");
            execSession.close();
            execSession = null;
            isProcessing = false;
            outputBuffer = "";
            send({ type: "status", status: "idle" });
          }
          break;

        case "set_model":
          if (msg.model) {
            currentModel = msg.model;
            log.info({ model: currentModel }, "Model changed");
            send({
              type: "status",
              status: isProcessing ? "thinking" : "idle",
              model: currentModel,
            });
          }
          break;

        default:
          send({ type: "error", message: `Unknown message type: ${msg.type}` });
      }
    });

    socket.on("close", () => {
      log.info("Session chat disconnected");
      if (execSession) {
        execSession.close();
        execSession = null;
      }
    });
  });
}

/** Build auth environment variables for the claude process in the pod. */
async function buildAuthEnv(log: {
  warn: (obj: any, msg: string) => void;
}): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const { retrieveSecret } = await import("../services/secret-service.js");
    const authMode = (await retrieveSecret("CLAUDE_AUTH_MODE").catch(() => null)) as string | null;

    if (authMode === "api-key") {
      const apiKey = await retrieveSecret("ANTHROPIC_API_KEY").catch(() => null);
      if (apiKey) {
        env.ANTHROPIC_API_KEY = apiKey as string;
      }
    } else if (authMode === "max-subscription") {
      const { getClaudeAuthToken } = await import("../services/auth-service.js");
      const result = getClaudeAuthToken();
      if (result.available && result.token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = result.token;
      }
    } else if (authMode === "oauth-token") {
      const token = await retrieveSecret("CLAUDE_CODE_OAUTH_TOKEN").catch(() => null);
      if (token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = token as string;
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to build auth env for session chat");
  }

  return env;
}

/** Update the cumulative cost on the session record. */
async function updateSessionCost(sessionId: string, costUsd: number) {
  await db
    .update(interactiveSessions)
    .set({ costUsd: costUsd.toFixed(4) })
    .where(eq(interactiveSessions.id, sessionId));
}
