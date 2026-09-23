/**
 * A live log frame is the stored row: same id, timestamp, logType and
 * metadata as `GET /api/tasks/:id/logs` (and the catch-up replay) returns for
 * it. Clients merge REST history with the live stream and drop duplicates by
 * those fields; a frame stamped with the API's own clock and missing the type
 * never matched, so lines at the seam showed twice and live lines lost their
 * formatting until a reload. Real Postgres (the stored timestamp comes from
 * the database default) and real Redis (the pub/sub hop).
 */
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { prReviewRuns, prReviews, taskLogs } from "../db/schema.js";
import { appendTaskLog } from "../services/task-service.js";
import { appendRunLog } from "../workers/pr-review-worker.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { listenWsApp, WsTestClient, type WsFrame } from "../test-utils/integration/ws-client.js";
import { taskRoutes } from "../routes/tasks.js";
import { logStreamWs } from "./log-stream.js";
import { prReviewLogStreamWs } from "./pr-review-log-stream.js";

let app: FastifyInstance;
let wsBase = "";
let redis: Redis;
const savedAuthDisabled = process.env.OPTIO_AUTH_DISABLED;

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "true";
  ({ app, wsBase } = await listenWsApp([logStreamWs, prReviewLogStreamWs]));
  redis = new Redis(process.env.REDIS_URL!);
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  if (savedAuthDisabled === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuthDisabled;
});

/**
 * Wait until the stream's Redis subscription is live: publish a harmless
 * probe the route forwards until the client sees it.
 */
async function waitSubscribed(client: WsTestClient, channel: string, probe: WsFrame) {
  const seen = client.next((f) => f.type === probe.type, 5_000);
  const timer = setInterval(() => void redis.publish(channel, JSON.stringify(probe)), 50);
  try {
    await seen;
  } finally {
    clearInterval(timer);
  }
}

describe("/ws/logs/:taskId", () => {
  it("sends each line live as GET /api/tasks/:id/logs returns it", async () => {
    const ws = await insertWorkspace();
    const task = await insertTask({ workspaceId: ws.id, state: "running" });
    await appendTaskLog(task.id, "stored before connect", "stdout", "text");

    const client = new WsTestClient(`${wsBase}/ws/logs/${task.id}`);
    // Catch-up frames carry the row id too.
    const replayed = await client.next((f) => f.type === "task:log" && f.catchUp === true);
    await waitSubscribed(client, `optio:task:${task.id}`, {
      type: "task:recovered",
      taskId: task.id,
    });

    await appendTaskLog(task.id, "live line", "stdout", "tool_use", {
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    const live = await client.next((f) => f.type === "task:log" && f.content === "live line");
    await client.close();

    const rest = await buildRouteTestApp(taskRoutes, {
      user: { id: "u-it", workspaceId: ws.id, workspaceRole: "admin" },
    });
    const res = await rest.inject({ method: "GET", url: `/api/tasks/${task.id}/logs` });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().logs as WsFrame[];
    await rest.close();

    const liveRow = rows.find((r) => r.content === "live line")!;
    expect(live).toMatchObject({
      taskId: task.id,
      id: liveRow.id,
      stream: liveRow.stream,
      timestamp: liveRow.timestamp,
      logType: "tool_use",
      metadata: { toolName: "Bash", toolInput: { command: "ls" } },
    });
    expect(live.catchUp).toBeUndefined();

    const storedRow = rows.find((r) => r.content === "stored before connect")!;
    expect(replayed).toMatchObject({
      id: storedRow.id,
      timestamp: storedRow.timestamp,
      logType: "text",
    });
  });
});

describe("/ws/pr-reviews/:id/logs", () => {
  it("stamps a live run log with the stored row's timestamp", async () => {
    // Workspace-less: the auth-disabled dev user may only stream those.
    const [review] = await db
      .insert(prReviews)
      .values({
        prUrl: "https://github.com/it-org/logs/pull/1",
        prNumber: 1,
        repoOwner: "it-org",
        repoName: "logs",
        repoUrl: "https://github.com/it-org/logs",
        headSha: "abc123",
      })
      .returning();
    const [run] = await db.insert(prReviewRuns).values({ prReviewId: review.id }).returning();

    const client = new WsTestClient(`${wsBase}/ws/pr-reviews/${review.id}/logs`);
    await waitSubscribed(client, `optio:pr-review:${review.id}`, {
      type: "pr_review:stale",
      prReviewId: review.id,
    });
    await appendRunLog(run, "reviewing", "stdout", "text");
    const live = await client.next(
      (f) => f.type === "pr_review_run:log" && f.content === "reviewing",
    );
    await client.close();

    const [row] = await db.select().from(taskLogs).where(eq(taskLogs.prReviewRunId, run.id));
    expect(live.timestamp).toBe(row.timestamp.toISOString());
    expect(live).toMatchObject({ runId: run.id, logType: "text" });
  });
});
