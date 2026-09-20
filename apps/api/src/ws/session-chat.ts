import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRuntime } from "../services/container-service.js";
import {
  appendSessionChatEvent,
  getSession,
  listSessionChatEvents,
  updateSessionAgentSessionId,
} from "../services/interactive-session-service.js";
import { getSettings } from "../services/optio-settings-service.js";
import { db } from "../db/client.js";
import { repoPods, repos, interactiveSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { parseClaudeEvent } from "../services/agent-event-parser.js";
import type { AgentLogEntry, ExecSession } from "@optio/shared";
import { shellSingleQuote } from "../utils/pod-env.js";
import {
  buildClaudeChatCommand,
  inspectClaudeLine,
  parseExitSentinel,
  shouldFallbackToFreshSession,
} from "./session-chat-resume.js";
import { authenticateWs, extractSessionToken } from "./ws-auth.js";
import { requireWsRole } from "./ws-authz.js";
import {
  getClientIp,
  trackConnection,
  releaseConnection,
  isMessageWithinSizeLimit,
  WS_CLOSE_CONNECTION_LIMIT,
  WS_CLOSE_MESSAGE_TOO_LARGE,
} from "./ws-limits.js";

/**
 * Session chat WebSocket handler.
 *
 * Runs one `claude -p` exec per user message inside the pod's session
 * worktree and streams its stream-json events back over the WebSocket. The
 * turns form a single conversation: Claude's `session_id` is captured from the
 * first turn, persisted on the session row, and passed as `--resume <id>` on
 * every later turn (including after the WebSocket reconnects). If a resume
 * fails because the session is gone, the stored id is cleared and the prompt
 * is re-run as a fresh conversation.
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
      releaseConnection(clientIp);
      return;
    }

    // Chat drives an agent that mutates the workspace — viewers are read-only.
    if (!(await requireWsRole(socket, user, "member", session.workspaceId))) {
      releaseConnection(clientIp);
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

    // Get repo config for model defaults
    const [repoConfig] = await db.select().from(repos).where(eq(repos.repoUrl, session.repoUrl));

    // Load Optio agent settings (model, system prompt, tool filtering, etc.)
    const workspaceId = req.user?.workspaceId ?? null;
    const optioSettings = await getSettings(workspaceId);

    // Optio settings take precedence, then repo config, then default
    let currentModel = optioSettings.model || repoConfig?.claudeModel || "sonnet";

    const rt = getRuntime();
    const handle = { id: pod.podId ?? pod.podName, name: pod.podName };
    const worktreePath = session.worktreePath ?? "/workspace/repo";

    let execSession: ExecSession | null = null;
    let cumulativeCost = 0;
    let isProcessing = false;
    let outputBuffer = "";
    let promptCount = 0;
    // Claude Code session id this chat resumes from. Loaded from the session
    // row so a new WS connection continues the same conversation.
    let agentSessionId: string | null = session.agentSessionId ?? null;

    // Resolve auth env vars for the claude process
    const authEnv = await buildAuthEnv(log, user.id);

    const send = (msg: Record<string, unknown>) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Send initial status with model info and settings
    send({
      type: "status",
      status: "ready",
      model: currentModel,
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

    const rememberAgentSessionId = (id: string) => {
      if (id === agentSessionId) return;
      const isFirst = agentSessionId === null;
      agentSessionId = id;
      log.info({ agentSessionId: id, isFirst }, "Claude session id captured");
      updateSessionAgentSessionId(sessionId, id).catch((err) => {
        log.warn({ err }, "Failed to persist agent session id");
      });
    };

    const forgetAgentSessionId = async (reason: string) => {
      const stale = agentSessionId;
      agentSessionId = null;
      log.warn({ staleAgentSessionId: stale, reason }, "Clearing unresumable Claude session id");
      await updateSessionAgentSessionId(sessionId, null).catch((err) => {
        log.warn({ err }, "Failed to clear agent session id");
      });
    };

    const emitEntry = (entry: AgentLogEntry) => {
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
    };

    /**
     * Run one `claude -p` exec for a prompt, optionally resuming a Claude
     * session. Resolves with whether the turn should be retried as a fresh
     * conversation because `--resume` could not find the session.
     *
     * Until a resumed turn has produced the init event, its output is held
     * back: if the turn turns out to be a failed resume, the "No conversation
     * found" noise and the error result are swallowed instead of being shown
     * to the user before the retry.
     */
    const executeTurn = async (
      fullPrompt: string,
      resumeSessionId: string | null,
    ): Promise<{ fallback: boolean }> => {
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

      const script = [
        "set -e",
        // Wait for repo to be ready
        "for i in $(seq 1 30); do [ -f /workspace/.ready ] && break; sleep 1; done",
        '[ -f /workspace/.ready ] || { echo "Repo not ready"; exit 1; }',
        `cd ${shellSingleQuote(worktreePath)}`,
        // Set auth env vars for the Claude process
        ...Object.entries(authEnv).map(([k, v]) => `export ${k}=${shellSingleQuote(v)}`),
        // Set auth passthrough env vars for Optio API calls
        ...Object.entries(passthroughEnv).map(([k, v]) => `export ${k}=${shellSingleQuote(v)}`),
        // Run claude in one-shot prompt mode with streaming JSON output,
        // resuming the stored conversation when we have one.
        buildClaudeChatCommand({ prompt: fullPrompt, model: currentModel, resumeSessionId }),
      ].join("\n");

      const resumed = resumeSessionId !== null;
      let sawInit = false;
      let sawErrorResult = false;
      let exitCode: number | null = null;
      let rawOutput = "";
      let heldBack: AgentLogEntry[] = [];

      const flushHeldBack = () => {
        for (const entry of heldBack) emitEntry(entry);
        heldBack = [];
      };

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        const sentinel = parseExitSentinel(line);
        if (sentinel !== null) {
          exitCode = sentinel;
          return;
        }
        const info = inspectClaudeLine(line);
        if (info.isInit) {
          sawInit = true;
          if (info.sessionId) rememberAgentSessionId(info.sessionId);
          flushHeldBack();
        } else if (!sawInit) {
          if (info.isErrorResult) sawErrorResult = true;
          if (!info.sessionId) rawOutput += line + "\n";
        }
        const { entries } = parseClaudeEvent(line, sessionId);
        for (const entry of entries) {
          if (resumed && !sawInit) heldBack.push(entry);
          else emitEntry(entry);
        }
      };

      execSession = await rt.exec(handle, ["bash", "-c", script], { tty: false });
      const thisExec = execSession;

      thisExec.stdout.on("data", (chunk: Buffer) => {
        outputBuffer += chunk.toString("utf-8");

        // Process complete lines
        const lines = outputBuffer.split("\n");
        outputBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      thisExec.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trim();
        if (text) {
          rawOutput += text + "\n";
          const entry: AgentLogEntry = {
            taskId: sessionId,
            timestamp: new Date().toISOString(),
            type: "error",
            content: text,
          };
          if (resumed && !sawInit) heldBack.push(entry);
          else emitEntry(entry);
        }
      });

      // Wait for the exec to finish
      await new Promise<void>((resolve) => {
        thisExec.stdout.on("end", () => {
          // Process any remaining buffer
          if (outputBuffer.trim()) handleLine(outputBuffer);
          outputBuffer = "";
          resolve();
        });
      });

      const fallback = shouldFallbackToFreshSession({
        resumed,
        exitCode,
        sawInit,
        sawErrorResult,
        rawOutput,
      });
      if (fallback) {
        log.warn(
          { resumeSessionId, exitCode, output: rawOutput.slice(0, 500) },
          "Claude --resume failed; retrying prompt as a fresh conversation",
        );
      } else {
        flushHeldBack();
      }
      return { fallback };
    };

    /**
     * Execute a single claude prompt in the pod worktree, resuming the
     * stored Claude session so successive messages share one conversation.
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

      try {
        const { fallback } = await executeTurn(fullPrompt, agentSessionId);
        // An interrupt clears execSession; don't start a second exec then.
        if (fallback && execSession !== null) {
          await forgetAgentSessionId("resume_failed");
          emitEntry({
            taskId: sessionId,
            timestamp: new Date().toISOString(),
            type: "info",
            content:
              "Previous conversation could not be resumed (the workspace was likely recreated); starting a fresh conversation.",
          });
          await executeTurn(fullPrompt, null);
        }
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
async function buildAuthEnv(
  log: { warn: (obj: any, msg: string) => void },
  userId?: string | null,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  try {
    const { retrieveSecret, retrieveSecretWithFallback } =
      await import("../services/secret-service.js");
    const authMode = (await retrieveSecret("CLAUDE_AUTH_MODE").catch(() => null)) as string | null;

    if (authMode === "api-key") {
      const apiKey = await retrieveSecretWithFallback(
        "ANTHROPIC_API_KEY",
        "global",
        undefined,
        userId,
      ).catch(() => null);
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
      const token = await retrieveSecretWithFallback(
        "CLAUDE_CODE_OAUTH_TOKEN",
        "global",
        undefined,
        userId,
      ).catch(() => null);
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
