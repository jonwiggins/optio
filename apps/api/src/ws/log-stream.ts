import type { FastifyInstance } from "fastify";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { getTask, getTaskLogs } from "../services/task-service.js";
import {
  getClientIp,
  trackConnection,
  releaseConnection,
  WS_CLOSE_CONNECTION_LIMIT,
} from "./ws-limits.js";

export async function logStreamWs(app: FastifyInstance) {
  app.get("/ws/logs/:taskId", { websocket: true }, async (socket, req) => {
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

    const { taskId } = req.params as { taskId: string };

    // Verify the task exists and belongs to the user's workspace
    const task = await getTask(taskId);
    if (!task) {
      socket.close(4404, "Task not found");
      return;
    }
    if (user.workspaceId && task.workspaceId && task.workspaceId !== user.workspaceId) {
      socket.close(4403, "Access denied");
      return;
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

    const subscriber = createSubscriber();

    const channel = `optio:task:${taskId}`;
    subscriber.subscribe(channel);

    subscriber.on("message", (_ch: string, message: string) => {
      try {
        const event = JSON.parse(message);
        if (event.type === "task:log" || event.type === "task:state_changed") {
          socket.send(message);
        }
      } catch {
        // ignore parse errors
      }
    });

    socket.on("close", () => {
      releaseConnection(clientIp);
      subscriber.unsubscribe(channel);
      subscriber.disconnect();
    });
  });
}
