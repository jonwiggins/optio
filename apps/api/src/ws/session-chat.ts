import { createLegacySessionChat } from "../services/legacy-session-chat-service.js";
export { recordSessionUsage } from "../services/legacy-session-chat-service.js";
import { randomUUID } from "node:crypto";
import {
  latestSessionTurn,
  subscribeSessionChat,
  interruptSessionChat,
} from "../services/session-turn-service.js";
import { canJoinSession, watchSessionAccess } from "../services/session-sharing-service.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSession, listSessionChatEvents } from "../services/interactive-session-service.js";
import { logger } from "../logger.js";
import { authenticateWs } from "./ws-auth.js";
import { requireWsRole } from "./ws-authz.js";
import { acceptWs, serializeWsInput } from "./ws-connection.js";
import { isMessageWithinSizeLimit, WS_CLOSE_MESSAGE_TOO_LARGE } from "./ws-limits.js";

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
 *   { type: "history_done", count: number }       — end of the history replay
 *   { type: "cost_update", costUsd: number }      — cumulative cost update
 *   { type: "status", status: string }            — "ready" | "thinking" | "idle" | "error"
 *   { type: "error", message: string }            — error message
 *
 * On connect the server sends `status: "ready"` (model, settings), then the
 * persisted history as `chat_event` frames flagged `catchUp: true`, then
 * `history_done` with the number of frames replayed; everything after it is
 * live. Clients may send as soon as the socket opens: messages that arrive
 * during auth, setup, or the replay are queued and handled in order right
 * after `history_done`, never dropped. (Clients that load history over REST —
 * `GET /api/sessions/:id/chat` — skip the `catchUp` frames and can ignore
 * `history_done`.)
 */
export async function sessionChatWs(app: FastifyInstance) {
  app.get("/ws/sessions/:sessionId/chat", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await: a prompt sent right after the socket
    // opens (or right after `ready`) is held until the replay below is done
    // and the handler listens (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    const { sessionId } = z.object({ sessionId: z.string() }).parse(req.params);
    const log = logger.child({ sessionId, ws: "session-chat" });

    const reject = (message: string) => {
      socket.send(JSON.stringify({ type: "error", message }));
      socket.close();
      conn.discard();
    };

    const session = await getSession(sessionId);
    if (!session) return reject("Session not found");

    if (!(await canJoinSession("pod", session, user))) {
      socket.close(4403, "Not authorized for this session");
      return conn.discard();
    }

    // Chat drives an agent that mutates the workspace — viewers are read-only.
    if (!(await requireWsRole(socket, user, "member", session.workspaceId))) {
      return conn.discard();
    }

    if (session.state !== "active") return reject("Session is not active");
    if (session.agentRuntime) {
      const { attachHarnessChat } = await import("./harness-session-chat.js");
      const mayInput = watchSessionAccess("pod", session, user, socket);
      await attachHarnessChat(socket, conn, sessionId, mayInput);
      return;
    }
    if (!session.podId) return reject("Session has no pod assigned");

    const mayInput = watchSessionAccess("pod", session, user, socket);
    const send = (msg: Record<string, unknown>) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(msg));
    };
    let runner: Awaited<ReturnType<typeof createLegacySessionChat>>;
    try {
      runner = await createLegacySessionChat(session, send);
    } catch (err) {
      return reject(err instanceof Error ? err.message : "Unable to open session chat");
    }
    if (conn.closed) return;
    conn.onClose(subscribeSessionChat(sessionId, send));
    const latestTurn = await latestSessionTurn(sessionId);
    send({
      type: "status",
      status: latestTurn?.state === "running" ? "thinking" : "ready",
      model: runner.model,
      costUsd: runner.costUsd,
      settings: {
        maxTurns: runner.settings.maxTurns,
        confirmWrites: runner.settings.confirmWrites,
        enabledTools: runner.settings.enabledTools,
      },
    });

    // Catch-up: replay persisted chat events so reconnecting clients see
    // the conversation from before the WebSocket dropped. The REST endpoint
    // is the primary loader, but this also helps clients that connect via
    // the WebSocket without first calling the REST endpoint.
    let replayed = 0;
    try {
      const history = await listSessionChatEvents(sessionId);
      for (const ev of history) {
        replayed++;
        send({
          type: "chat_event",
          event: {
            taskId: sessionId,
            timestamp:
              ev.timestamp instanceof Date
                ? ev.timestamp.toISOString()
                : (ev.timestamp as unknown as string),
            type: (ev.logType ?? "text") as
              "text" | "tool_use" | "tool_result" | "thinking" | "system" | "error" | "info",
            content: ev.content,
            metadata: ev.metadata ?? undefined,
          },
          catchUp: true,
        });
      }
    } catch (err) {
      log.warn({ err }, "Failed to replay session chat history");
    }
    // The replay boundary: everything after this frame is live.
    send({ type: "history_done", count: replayed });

    // A viewer leaving does not stop the turn. It keeps streaming to the
    // durable history and other collaborators until done or interrupted.
    conn.onClose(() => log.info("Session chat viewer disconnected"));

    // Handle incoming messages from the client — first the ones that arrived
    // during setup and the replay above, in order, then live ones.
    conn.ready(
      serializeWsInput(socket, async (data: Buffer | string) => {
        if (!(await mayInput())) return;
        if (!isMessageWithinSizeLimit(data)) {
          socket.close(WS_CLOSE_MESSAGE_TOO_LARGE, "Message too large");
          return;
        }

        const str = typeof data === "string" ? data : data.toString("utf-8");

        let msg: { type: string; content?: string; model?: string; requestId?: string };
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
            if (
              msg.requestId !== undefined &&
              !z.string().uuid().safeParse(msg.requestId).success
            ) {
              send({ type: "error", message: "Invalid request ID" });
              return;
            }
            runner.runPrompt(msg.content, msg.requestId ?? randomUUID()).catch((err) => {
              log.error({ err }, "Prompt execution failed");
              send({ type: "error", message: "Prompt failed" });
            });
            break;

          case "interrupt":
            // Stops the turn wherever it runs (this instance's exec at once,
            // the durable flag and the bus for another instance's).
            interruptSessionChat(sessionId).catch((err) =>
              log.warn({ err }, "interrupt could not reach every instance"),
            );
            break;

          case "set_model":
            if (msg.model) {
              runner.setModel(msg.model);
              log.info({ model: runner.model }, "Model changed");
              send({
                type: "status",
                status: runner.processing ? "thinking" : "idle",
                model: runner.model,
              });
            }
            break;

          default:
            send({ type: "error", message: `Unknown message type: ${msg.type}` });
        }
      }),
    );
  });
}
