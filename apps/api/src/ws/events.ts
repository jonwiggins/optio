import type { FastifyInstance } from "fastify";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { getRecentEvents } from "../services/task-service.js";
import { acceptWs } from "./ws-connection.js";
import { isAuthDisabled } from "../services/oauth/index.js";

export async function eventsWs(app: FastifyInstance) {
  app.get("/ws/events", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    // Send catch-up: recent state-change events so reconnecting clients stay in sync
    try {
      const recentEvents = await getRecentEvents({ limit: 20 });
      for (const event of recentEvents) {
        socket.send(
          JSON.stringify({
            type: "task:state_changed",
            taskId: event.taskId,
            fromState: event.fromState,
            toState: event.toState,
            timestamp: event.createdAt,
            catchUp: true,
          }),
        );
      }
    } catch {
      // ignore catch-up errors — still subscribe to live events
    }
    if (conn.closed) return;

    const subscriber = createSubscriber();
    const channel = "optio:events";
    subscriber.subscribe(channel);

    // This channel fans out to every authenticated user. Two kinds of frame
    // are private: `local:changed` nudges (a terminal / host / user id of
    // their owner) and events about **private work** — a task, Job run or
    // agent with an `ownerUserId` — which only its owner and workspace admins
    // may see (services/ownership.ts). Dev / auth-disabled has one user and
    // null owners, so everything passes.
    const isAdmin = isAuthDisabled() || user.workspaceRole === "admin";
    subscriber.on("message", (_ch: string, message: string) => {
      if (message.includes('"local:changed"') || message.includes('"ownerUserId"')) {
        try {
          const evt = JSON.parse(message) as {
            type?: string;
            userId?: string | null;
            ownerUserId?: string | null;
          };
          if (evt.type === "local:changed" && evt.userId && evt.userId !== user.id) return;
          if (evt.ownerUserId && evt.ownerUserId !== user.id && !isAdmin) return;
        } catch {
          // Unparseable — fall through and forward (matches prior behavior).
        }
      }
      socket.send(message);
    });

    conn.onClose(() => {
      subscriber.unsubscribe(channel);
      subscriber.disconnect();
    });
    // Server → client only: client frames are ignored.
    conn.ready(() => {});
  });
}
