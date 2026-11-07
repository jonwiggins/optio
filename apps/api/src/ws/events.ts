import type { FastifyInstance } from "fastify";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { getRecentEvents } from "../services/task-service.js";
import { acceptWs } from "./ws-connection.js";
import { globalEventFor } from "../services/event-visibility.js";
import { wsWorkActor } from "./ws-authz.js";

export async function eventsWs(app: FastifyInstance) {
  app.get("/ws/events", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    const actor = await wsWorkActor(user);

    // Send catch-up: recent state-change events so reconnecting clients stay in sync
    try {
      const recentEvents = await getRecentEvents({ actor, limit: 20 });
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
    subscriber.subscribe(channel).catch(() => {});

    // Resolve resource ownership from stored rows, not optional event fields.
    // Serialize lookups so async authorization cannot reorder state changes.
    let pending = Promise.resolve();
    subscriber.on("message", (_ch: string, message: string) => {
      let event: unknown;
      try {
        event = JSON.parse(message);
      } catch {
        return; // Malformed messages fail closed.
      }
      // Log content only belongs on the separately authorized entity stream.
      if (
        typeof event !== "object" ||
        event === null ||
        ("type" in event && typeof event.type === "string" && event.type.endsWith(":log"))
      )
        return;
      pending = pending
        .then(async () => {
          if (conn.closed) return;
          const visible = await globalEventFor(event, actor);
          if (visible && !conn.closed) socket.send(JSON.stringify(visible));
        })
        .catch(() => {
          /* Failed authorization/lookups never forward a frame. */
        });
    });

    conn.onClose(() => {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
    });
    // Server → client only: client frames are ignored.
    conn.ready(() => {});
  });
}
