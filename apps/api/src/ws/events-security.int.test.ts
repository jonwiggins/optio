import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { persistentAgents, taskEvents, users, workspaceMembers } from "../db/schema.js";
import { createApiKey } from "../services/api-key-service.js";
import { globalEventFor } from "../services/event-visibility.js";
import { getRecentEvents } from "../services/task-service.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { listenWsApp, WsTestClient } from "../test-utils/integration/ws-client.js";
import { eventsWs } from "./events.js";
import { logStreamWs } from "./log-stream.js";
import { persistentAgentStreamWs } from "./persistent-agent-stream.js";
import { workflowRunLogStreamWs } from "./workflow-run-log-stream.js";

let app: FastifyInstance;
let wsBase: string;
let redis: Redis;
let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;
let coworkerId: string;
let token: string;
const clients: WsTestClient[] = [];
const savedAuth = process.env.OPTIO_AUTH_DISABLED;
const actor = () => ({ workspaceId, userId, isAdmin: false });

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  workspaceId = (await insertWorkspace()).id;
  otherWorkspaceId = (await insertWorkspace()).id;
  const inserted = await db
    .insert(users)
    .values(
      [0, 1].map((n) => ({
        provider: "github",
        externalId: randomUUID(),
        email: `events-${n}@example.test`,
        displayName: `Events ${n}`,
        defaultWorkspaceId: workspaceId,
      })),
    )
    .returning();
  [userId, coworkerId] = inserted.map((u) => u.id);
  await db.insert(workspaceMembers).values(
    inserted.map((u) => ({
      workspaceId,
      userId: u.id,
      role: "member" as const,
    })),
  );
  token = (await createApiKey(userId, "events security")).token;
  ({ app, wsBase } = await listenWsApp([
    eventsWs,
    logStreamWs,
    persistentAgentStreamWs,
    workflowRunLogStreamWs,
  ]));
  redis = new Redis(process.env.REDIS_URL!);
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await app?.close();
  redis?.disconnect();
  if (savedAuth === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuth;
});

function connect(path: string) {
  const client = new WsTestClient(`${wsBase}${path}`, { token });
  clients.push(client);
  return client;
}

describe("event and log visibility", () => {
  it("scopes state-change catch-up to the workspace and visible owners, even for admins", async () => {
    const organization = await insertTask({ workspaceId });
    const own = await insertTask({ workspaceId, ownerUserId: userId });
    const privateTask = await insertTask({ workspaceId, ownerUserId: coworkerId });
    const foreign = await insertTask({ workspaceId: otherWorkspaceId });
    const legacy = await insertTask({ workspaceId: null });
    await db.insert(taskEvents).values(
      [organization, own, privateTask, foreign, legacy].map((task) => ({
        taskId: task.id,
        fromState: "pending" as const,
        toState: "queued" as const,
        trigger: "test",
      })),
    );
    expect((await getRecentEvents({ actor: actor() })).map((e) => e.taskId).sort()).toEqual(
      [organization.id, own.id].sort(),
    );
    expect(
      (await getRecentEvents({ actor: { ...actor(), isAdmin: true } })).map((e) => e.taskId).sort(),
    ).toEqual([organization.id, own.id, privateTask.id].sort());
  });

  it("authorizes global task frames from stored ownership when producer fields are absent or forged", async () => {
    const own = await insertTask({ workspaceId, ownerUserId: userId });
    const privateTask = await insertTask({ workspaceId, ownerUserId: coworkerId });
    const foreign = await insertTask({ workspaceId: otherWorkspaceId });
    const frame = (taskId: string) => ({ type: "task:created", taskId, title: "private task" });
    expect(await globalEventFor(frame(own.id), actor())).toEqual(frame(own.id));
    expect(await globalEventFor(frame(privateTask.id), actor())).toBeNull();
    expect(
      await globalEventFor({ ...frame(privateTask.id), ownerUserId: userId }, actor()),
    ).toBeNull();
    expect(await globalEventFor(frame(foreign.id), { ...actor(), isAdmin: true })).toBeNull();
    expect(await globalEventFor(frame(randomUUID()), actor())).toBeNull();
    expect(await globalEventFor({ type: "future:unknown", content: "secret" }, actor())).toBeNull();
  });

  it("denies private and null-workspace task logs before catch-up or subscription", async () => {
    const privateTask = await insertTask({ workspaceId, ownerUserId: coworkerId });
    const legacy = await insertTask({ workspaceId: null });
    for (const task of [privateTask, legacy]) {
      const client = connect(`/ws/logs/${task.id}`);
      expect((await client.closed).code).toBe(4403);
      expect(client.frames).toEqual([]);
    }
  });

  it("denies private Job and persistent-agent streams and their global frames", async () => {
    const job = await insertWorkflow({ workspaceId, ownerUserId: coworkerId });
    const run = await insertWorkflowRun(job.id);
    const [agent] = await db
      .insert(persistentAgents)
      .values({
        workspaceId,
        ownerUserId: coworkerId,
        slug: `private-${randomUUID()}`,
        name: "private",
        initialPrompt: "private",
      })
      .returning();
    for (const path of [
      `/ws/workflow-runs/${run.id}/logs`,
      `/ws/persistent-agents/${agent.id}/events`,
    ]) {
      const client = connect(path);
      expect((await client.closed).code).toBe(4403);
      expect(client.frames).toEqual([]);
    }
    expect(
      await globalEventFor({ type: "workflow_run:state_changed", workflowRunId: run.id }, actor()),
    ).toBeNull();
    expect(
      await globalEventFor(
        { type: "persistent_agent:turn_halted", agentId: agent.id, summary: "private" },
        actor(),
      ),
    ).toBeNull();
  });

  it("drops unscoped activity and log payloads from the global socket, while forwarding authorized state events", async () => {
    const own = await insertTask({ workspaceId, ownerUserId: userId });
    const privateTask = await insertTask({ workspaceId, ownerUserId: coworkerId });
    const foreign = await insertTask({ workspaceId: otherWorkspaceId });
    const client = connect("/ws/events");
    await client.opened;
    const publish = (event: unknown) =>
      redis.publish("optio:events", typeof event === "string" ? event : JSON.stringify(event));
    // Wait until this socket's server is subscribed. Pub/sub channels are
    // server-wide, not per logical DB, so counting optio:events subscribers
    // (NUMSUB) also counts every other test server on this Redis (the e2e
    // suites check:push runs alongside): hear a visible event instead.
    await expect
      .poll(async () => {
        await publish({ type: "task:created", taskId: own.id, title: "subscribed" });
        return client.frames.some((f) => f.title === "subscribed");
      })
      .toBe(true);
    await publish("malformed secret");
    await publish({ type: "activity:new", summary: "secret audit details" });
    await publish({ type: "task:log", taskId: own.id, content: "global log secret" });
    await publish({ type: "task:message", taskId: own.id, content: "own message secret" });
    await publish({ type: "task:message", taskId: privateTask.id, content: "coworker secret" });
    await publish({ type: "task:message", taskId: foreign.id, content: "foreign secret" });
    await publish({ type: "task:created", taskId: own.id, title: "visible barrier" });
    await client.next((f) => f.title === "visible barrier");
    expect(JSON.stringify(client.frames)).not.toContain("secret");
    expect(client.frames.some((f) => f.taskId === privateTask.id || f.taskId === foreign.id)).toBe(
      false,
    );
    await client.close();
  });
});
