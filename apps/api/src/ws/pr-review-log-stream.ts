import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { getPrReview, getLatestRun } from "../services/pr-review-service.js";
import { db } from "../db/client.js";
import { taskLogs } from "../db/schema.js";
import {
  getClientIp,
  trackConnection,
  releaseConnection,
  WS_CLOSE_CONNECTION_LIMIT,
} from "./ws-limits.js";

export async function prReviewLogStreamWs(app: FastifyInstance) {
  app.get("/ws/pr-reviews/:id/logs", { websocket: true }, async (socket, req) => {
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

    const { id } = z.object({ id: z.string() }).parse(req.params);

    const review = await getPrReview(id);
    if (!review) {
      socket.close(4404, "PR review not found");
      releaseConnection(clientIp);
      return;
    }
    if (user.workspaceId && review.workspaceId && review.workspaceId !== user.workspaceId) {
      socket.close(4403, "Access denied");
      releaseConnection(clientIp);
      return;
    }

    // Send catch-up: recent logs from the latest run so reconnecting clients
    // don't miss data. Logs are stored in task_logs keyed by pr_review_run_id.
    try {
      const latest = await getLatestRun(id);
      if (latest) {
        const recent = await db
          .select()
          .from(taskLogs)
          .where(eq(taskLogs.prReviewRunId, latest.id))
          .orderBy(taskLogs.timestamp)
          .limit(50);
        for (const log of recent) {
          socket.send(
            JSON.stringify({
              type: "pr_review_run:log",
              prReviewId: id,
              runId: latest.id,
              content: log.content,
              stream: log.stream,
              timestamp: log.timestamp,
              logType: log.logType,
              metadata: log.metadata,
              catchUp: true,
            }),
          );
        }
      }
    } catch {
      // ignore catch-up errors — still subscribe to live events
    }

    const subscriber = createSubscriber();
    const channel = `optio:pr-review:${id}`;
    subscriber.subscribe(channel);

    subscriber.on("message", (_ch: string, message: string) => {
      try {
        const event = JSON.parse(message);
        if (
          event.type === "pr_review_run:log" ||
          event.type === "pr_review_run:state_changed" ||
          event.type === "pr_review:state_changed" ||
          event.type === "pr_review:stale"
        ) {
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
