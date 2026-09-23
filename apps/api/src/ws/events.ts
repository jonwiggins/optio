import type { FastifyInstance } from "fastify";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { getRecentEvents } from "../services/task-service.js";
import { acceptWs } from "./ws-connection.js";

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

    subscriber.on("message", (_ch: string, message: string) => {
      // `local:changed` nudges carry a terminal/host/user id that is private to
      // the owner — this channel fans out to every authenticated user, so gate
      // those frames to their owner (dev/auth-disabled has a null owner and one
      // user, so it passes). Other event types keep their existing behavior.
      if (message.includes('"local:changed"')) {
        try {
          const evt = JSON.parse(message) as { type?: string; userId?: string | null };
          if (evt.type === "local:changed" && evt.userId && evt.userId !== user.id) return;
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
