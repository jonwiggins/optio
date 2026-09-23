import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSubscriber } from "../services/event-bus.js";
import { authenticateWs } from "./ws-auth.js";
import { assertWorkspace } from "./ws-authz.js";
import { getWorkflow, getWorkflowRun, getWorkflowRunLogs } from "../services/workflow-service.js";
import { acceptWs } from "./ws-connection.js";

export async function workflowRunLogStreamWs(app: FastifyInstance) {
  app.get("/ws/workflow-runs/:workflowRunId/logs", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    const { workflowRunId } = z.object({ workflowRunId: z.string() }).parse(req.params);

    // Verify the workflow run exists
    const run = await getWorkflowRun(workflowRunId);
    if (!run) {
      socket.close(4404, "Workflow run not found");
      return conn.discard();
    }

    // Enforce workspace isolation: a run's tenant is its parent workflow's.
    const workflow = await getWorkflow(run.workflowId);
    if (!assertWorkspace(socket, user.workspaceId, workflow?.workspaceId)) {
      return conn.discard();
    }

    // Send catch-up: recent logs so reconnecting clients don't miss data
    try {
      const recentLogs = await getWorkflowRunLogs(workflowRunId, { limit: 50 });
      for (const log of recentLogs) {
        socket.send(
          JSON.stringify({
            type: "workflow_run:log",
            workflowRunId,
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

    const channel = `optio:workflow-run:${workflowRunId}`;
    subscriber.subscribe(channel);

    subscriber.on("message", (_ch: string, message: string) => {
      try {
        const event = JSON.parse(message);
        if (event.type === "workflow_run:log" || event.type === "workflow_run:state_changed") {
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
