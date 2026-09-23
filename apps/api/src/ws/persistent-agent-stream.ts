// WebSocket route for live persistent-agent events.
//
// Streams state changes, turn started/halted, messages, and turn logs for a
// single agent. Catch-up: recent log history of the most recent turn.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { assertWorkspace } from "./ws-authz.js";
import {
  getPersistentAgentUnscoped,
  listPersistentAgentTurns,
  listTurnLogs,
} from "../services/persistent-agent-service.js";
import { acceptWs } from "./ws-connection.js";

export async function persistentAgentStreamWs(app: FastifyInstance) {
  app.get("/ws/persistent-agents/:agentId/events", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    const { agentId } = z.object({ agentId: z.string() }).parse(req.params);
    const agent = await getPersistentAgentUnscoped(agentId);
    if (!agent) {
      socket.close(4404, "Persistent agent not found");
      return conn.discard();
    }

    // Enforce workspace isolation before streaming the agent's turn output.
    if (!assertWorkspace(socket, user.workspaceId, agent.workspaceId)) {
      return conn.discard();
    }

    // Catch-up: send the most recent turn's logs so reconnecting clients see
    // recent activity without scrolling history.
    try {
      const recentTurns = await listPersistentAgentTurns(agentId, 1);
      if (recentTurns[0]) {
        const logs = await listTurnLogs(recentTurns[0].id, 200);
        for (const log of logs) {
          socket.send(
            JSON.stringify({
              type: "persistent_agent:log",
              agentId,
              agentSlug: agent.slug,
              turnId: log.turnId,
              content: log.content,
              stream: log.stream,
              logType: log.logType,
              metadata: log.metadata,
              timestamp: log.timestamp,
              catchUp: true,
            }),
          );
        }
      }
    } catch {
      // ignore catch-up errors
    }
    if (conn.closed) return;

    const subscriber = createSubscriber();
    const channel = `optio:persistent-agent:${agentId}`;
    subscriber.subscribe(channel);

    subscriber.on("message", (_ch: string, message: string) => {
      try {
        const event = JSON.parse(message);
        if (
          event.type === "persistent_agent:log" ||
          event.type === "persistent_agent:state_changed" ||
          event.type === "persistent_agent:message" ||
          event.type === "persistent_agent:turn_started" ||
          event.type === "persistent_agent:turn_halted"
        ) {
          socket.send(message);
        }
      } catch {
        // ignore parse errors
      }
    });

    conn.onClose(() => {
      subscriber.unsubscribe(channel);
      subscriber.disconnect();
    });
    // Server → client only: client frames are ignored.
    conn.ready(() => {});
  });
}
