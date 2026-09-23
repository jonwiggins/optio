import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { getTask, getTaskLogs } from "../services/task-service.js";
import { acceptWs } from "./ws-connection.js";

export async function logStreamWs(app: FastifyInstance) {
  app.get("/ws/logs/:taskId", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    const { taskId } = z.object({ taskId: z.string() }).parse(req.params);

    // Verify the task exists and belongs to the user's workspace
    const task = await getTask(taskId);
    if (!task) {
      socket.close(4404, "Task not found");
      return conn.discard();
    }
    if (user.workspaceId && task.workspaceId && task.workspaceId !== user.workspaceId) {
      socket.close(4403, "Access denied");
      return conn.discard();
    }

    // Send catch-up: recent logs so reconnecting clients don't miss data
    try {
      const recentLogs = await getTaskLogs(taskId, { limit: 50 });
      for (const log of recentLogs) {
        socket.send(
          JSON.stringify({
            type: "task:log",
            taskId,
            content: log.content,
            stream: log.stream,
            timestamp: log.timestamp,
            logType: log.logType,
            metadata: log.metadata,
            catchUp: true,
          }),
        );
      }
    } catch {
      // ignore catch-up errors — still subscribe to live events
    }
    if (conn.closed) return;

    const subscriber = createSubscriber();

    const channel = `optio:task:${taskId}`;
    subscriber.subscribe(channel);

    subscriber.on("message", (_ch: string, message: string) => {
      try {
        const event = JSON.parse(message);
        if (
          event.type === "task:log" ||
          event.type === "task:state_changed" ||
          event.type === "task:message" ||
          event.type === "task:message_delivered" ||
          event.type === "task:message_acked" ||
          event.type === "task:stalled" ||
          event.type === "task:recovered"
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
