import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRuntime } from "../services/container-service.js";
import {
  appendSessionChatEvent,
  getSession,
  listSessionChatEvents,
} from "../services/interactive-session-service.js";
import { getSettings } from "../services/optio-settings-service.js";
import { getAgentCredentials } from "../services/agent-credential-service.js";
import { db } from "../db/client.js";
import { repoPods, repos, interactiveSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { parseClaudeEvent } from "../services/agent-event-parser.js";
import { parseGeminiEvent } from "../services/gemini-event-parser.js";
import { publishSessionEvent } from "../services/event-bus.js";
import type { ExecSession, OptioSettings } from "@optio/shared";
import { authenticateWs, extractSessionToken } from "./ws-auth.js";
import {
  getClientIp,
  trackConnection,
  releaseConnection,
  isMessageWithinSizeLimit,
  WS_CLOSE_CONNECTION_LIMIT,
  WS_CLOSE_MESSAGE_TOO_LARGE,
} from "./ws-limits.js";
import { buildSetupFilesScript } from "../utils/setup-files.js";

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
    const clientIp = getClientIp(req);

    if (!trackConnection(clientIp)) {
      socket.close(WS_CLOSE_CONNECTION_LIMIT, "Too many connections");
      return;
    }

    const user = await authenticateWs(socket, req);
    if (!user) {
      releaseConnection(clientIp);
      return;
    }

    const { sessionId } = z.object({ sessionId: z.string() }).parse(req.params);
    const log = logger.child({ sessionId, ws: "session-chat" });

    // Extract the user's raw session token for auth passthrough.
    // This token will be injected into the pod environment so that API calls
    // made by the agent carry the user's identity.
    const userSessionToken = extractSessionToken(req);

    const session = await getSession(sessionId);
    if (!session) {
      socket.send(JSON.stringify({ type: "error", message: "Session not found" }));
      releaseConnection(clientIp);
      socket.close();
      return;
    }

    if (session.userId && session.userId !== user.id) {
      socket.close(4403, "Not authorized for this session");
      return;
    }

    if (session.state !== "active") {
      socket.send(JSON.stringify({ type: "error", message: "Session is not active" }));
      releaseConnection(clientIp);
      socket.close();
      return;
    }

    if (!session.podId) {
      socket.send(JSON.stringify({ type: "error", message: "Session has no pod assigned" }));
      releaseConnection(clientIp);
      socket.close();
      return;
    }

    // Get pod info
    const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, session.podId));
    if (!pod || !pod.podName) {
      socket.send(
        JSON.stringify({
          type: "error",
          message:
            "Session pod was cleaned up due to inactivity. Please end this session and start a new one.",
        }),
      );
      releaseConnection(clientIp);
      socket.close();
      return;
    }

    // Get repo config for model defaults and agent type
    const [repoConfig] = await db.select().from(repos).where(eq(repos.repoUrl, session.repoUrl));

    // Load Optio agent settings (model, system prompt, tool filtering, etc.)
    const workspaceId = req.user?.workspaceId ?? null;
    const optioSettings = await getSettings(workspaceId);

    // Determine agent type from repo config (defaults to claude-code)
    const agentType = (repoConfig?.defaultAgentType || "claude-code") as any;

    // Model selection depends on agent type - use repo config, not optio settings
    // (optioSettings.model is for Optio chat interface, not interactive sessions)
    let currentModel: string;
    if (agentType === "gemini") {
      currentModel = repoConfig?.geminiModel || "gemini-2.5-flash";
    } else {
      currentModel = repoConfig?.claudeModel || "sonnet";
    }

    const rt = getRuntime();
    const handle = { id: pod.podId ?? pod.podName, name: pod.podName };
    const worktreePath = session.worktreePath ?? "/workspace/repo";

    let execSession: ExecSession | null = null;
    let cumulativeCost = 0;
    let isProcessing = false;
    let outputBuffer = "";
    let promptCount = 0;

    // Resolve auth env vars and setup files for the agent
    let authEnv: Record<string, string> = {};
    let authSetupFiles: Array<{ path: string; content: string; sensitive?: boolean }> = [];
    try {
      const credentials = await getAgentCredentials(agentType, session.workspaceId, session.userId);
      authEnv = credentials.env;
      authSetupFiles = credentials.setupFiles ?? [];
      log.info(
        { agentType, envVarCount: Object.keys(authEnv).length },
        "Loaded agent credentials for session chat",
      );
    } catch (err) {
      log.warn({ err, agentType }, "Failed to retrieve agent credentials for session chat");
    }

    const send = (msg: Record<string, unknown>) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Send initial status with model info, agent type, and settings
    send({
      type: "status",
      status: "ready",
      model: currentModel,
      agentType,
      costUsd: cumulativeCost,
      settings: {
        maxTurns: optioSettings.maxTurns,
        confirmWrites: optioSettings.confirmWrites,
        enabledTools: optioSettings.enabledTools,
      },
    });

    // Catch-up: replay persisted chat events so reconnecting clients see
    // the conversation from before the WebSocket dropped. The REST endpoint
    // is the primary loader, but this also helps clients that connect via
    // the WebSocket without first calling the REST endpoint.
    try {
      const history = await listSessionChatEvents(sessionId);
      for (const ev of history) {
        send({
          type: "chat_event",
          event: {
            taskId: sessionId,
            timestamp:
              ev.timestamp instanceof Date
                ? ev.timestamp.toISOString()
                : (ev.timestamp as unknown as string),
            type: (ev.logType ?? "text") as
              | "text"
              | "tool_use"
              | "tool_result"
              | "thinking"
              | "system"
              | "error"
              | "info",
            content: ev.content,
            metadata: ev.metadata ?? undefined,
          },
          catchUp: true,
        });
      }
    } catch (err) {
      log.warn({ err }, "Failed to replay session chat history");
    }

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

      // Enforce max turns from settings
      promptCount++;
      if (promptCount > optioSettings.maxTurns) {
        send({
          type: "error",
          message: `Conversation limit reached (${optioSettings.maxTurns} turns). Please start a new session.`,
        });
        return;
      }

      isProcessing = true;
      send({ type: "status", status: "thinking" });

      // Append custom system prompt from settings if configured
      let fullPrompt = prompt;
      if (optioSettings.systemPrompt) {
        fullPrompt = `${prompt}\n\n[Additional instructions: ${optioSettings.systemPrompt}]`;
      }

      // Build the agent command
      const escapedPrompt = fullPrompt.replace(/'/g, "'\\''");
      let agentCommand: string;
      if (agentType === "gemini") {
        const modelFlag = currentModel ? `-m ${currentModel}` : "";
        agentCommand = `gemini -p '${escapedPrompt}' ${modelFlag} --output-format stream-json --approval-mode yolo < /dev/null || true`;
      } else {
        // claude-code, codex, copilot, etc.
        const modelFlag = currentModel ? `--model ${currentModel}` : "";
        agentCommand = `claude -p '${escapedPrompt}' ${modelFlag} --output-format stream-json --verbose --dangerously-skip-permissions < /dev/null || true`;
      }

      // Build auth passthrough env vars so the agent can make
      // authenticated API calls on behalf of the requesting user.
      const passthroughEnv: Record<string, string> = {};
      if (userSessionToken) {
        passthroughEnv.OPTIO_SESSION_TOKEN = userSessionToken;
      }
      const apiUrl = process.env.PUBLIC_URL || process.env.OPTIO_API_URL || "";
      if (apiUrl) {
        passthroughEnv.OPTIO_API_URL = apiUrl;
      }

      // Build script to write auth setup files (e.g., Vertex AI service account keys)
      const setupFilesScript = buildSetupFilesScript(
        authSetupFiles,
        "[optio] Writing agent credential files...",
      );

      const script = [
        "set -e",
        // Wait for repo to be ready
        "for i in $(seq 1 30); do [ -f /workspace/.ready ] && break; sleep 1; done",
        '[ -f /workspace/.ready ] || { echo "Repo not ready"; exit 1; }',
        // Write auth setup files if present
        ...(setupFilesScript ? [setupFilesScript] : []),
        `cd "${worktreePath}"`,
        // Set auth env vars for the agent process
        ...Object.entries(authEnv).map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`),
        // Set auth passthrough env vars for Optio API calls
        ...Object.entries(passthroughEnv).map(
          ([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`,
        ),
        // Run agent in one-shot prompt mode with streaming JSON output
        agentCommand,
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
            // Use agent-specific parser
            const { entries } =
              agentType === "gemini"
                ? parseGeminiEvent(line, sessionId)
                : parseClaudeEvent(line, sessionId);
            for (const entry of entries) {
              send({ type: "chat_event", event: entry });
              persistChatEvent(sessionId, entry, log);

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
            const entry = {
              taskId: sessionId,
              timestamp: new Date().toISOString(),
              type: "error" as const,
              content: text,
            };
            send({ type: "chat_event", event: entry });
            persistChatEvent(sessionId, entry, log);
          }
        });

        // Wait for the exec to finish
        await new Promise<void>((resolve) => {
          execSession!.stdout.on("end", () => {
            // Process any remaining buffer
            if (outputBuffer.trim()) {
              const { entries } =
                agentType === "gemini"
                  ? parseGeminiEvent(outputBuffer, sessionId)
                  : parseClaudeEvent(outputBuffer, sessionId);
              for (const entry of entries) {
                send({ type: "chat_event", event: entry });
                persistChatEvent(sessionId, entry, log);
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
      if (!isMessageWithinSizeLimit(data)) {
        socket.close(WS_CLOSE_MESSAGE_TOO_LARGE, "Message too large");
        return;
      }

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
          // Persist the user's prompt so reconnecting clients see their own
          // side of the conversation, not just the agent's responses. Use
          // logType=user_message so the UI can render it distinctly.
          appendSessionChatEvent({
            sessionId,
            content: msg.content,
            stream: "stdin",
            logType: "user_message",
          }).catch((err) => log.warn({ err }, "Failed to persist user message"));
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
              agentType,
            });
          }
          break;

        default:
          send({ type: "error", message: `Unknown message type: ${msg.type}` });
      }
    });

    socket.on("close", () => {
      log.info("Session chat disconnected");
      releaseConnection(clientIp);
      if (execSession) {
        execSession.close();
        execSession = null;
      }
    });
  });
}

/** Build auth environment variables for the claude process in the pod. */

/** Update the cumulative cost on the session record. */
async function updateSessionCost(sessionId: string, costUsd: number) {
  await db
    .update(interactiveSessions)
    .set({ costUsd: costUsd.toFixed(4) })
    .where(eq(interactiveSessions.id, sessionId));
}

/**
 * Fire-and-forget persistence for an agent chat event. Failures are logged
 * but don't break the live stream — the client still gets the event over
 * the WebSocket; only history-on-reconnect is impacted.
 */
function persistChatEvent(
  sessionId: string,
  entry: import("@optio/shared").AgentLogEntry,
  log: { warn: (obj: unknown, msg: string) => void },
) {
  appendSessionChatEvent({
    sessionId,
    content: entry.content,
    logType: entry.type,
    metadata: entry.metadata,
    timestamp: entry.timestamp ? new Date(entry.timestamp) : undefined,
  }).catch((err) => log.warn({ err }, "Failed to persist session chat event"));
}
