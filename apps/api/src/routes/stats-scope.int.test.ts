/**
 * The stats bars count what the lists next to them show: the organization's
 * work and the viewer's own (every row for an admin, who sees private rows
 * read-only). A member must not be able to read how much private work other
 * people have from a count. System status alerts stay within the workspace.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { agentPods, persistentAgents, podHealthEvents, users } from "../db/schema.js";
import { getRedisClient } from "../services/event-bus.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { optioRoutes } from "./optio.js";
import { persistentAgentRoutes } from "./persistent-agents.js";
import { taskRoutes } from "./tasks.js";
import { workflowRoutes } from "./workflows.js";

let ws: string;
let owner: string;
let other: string;

async function insertUser(displayName: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(4).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@stats.it`,
      displayName,
    })
    .returning();
  return row.id;
}

async function insertAgent(ownerUserId: string | null) {
  await db.insert(persistentAgents).values({
    workspaceId: ws,
    ownerUserId,
    slug: `agent-${randomUUID()}`,
    name: "agent",
    initialPrompt: "hi",
  });
}

async function insertCrashedPod(workspaceId: string, message: string) {
  const [pod] = await db
    .insert(agentPods)
    .values({
      pool: "repo",
      poolKey: `https://github.com/it-org/${randomUUID()}`,
      workspaceId,
      state: "error",
    } as typeof agentPods.$inferInsert)
    .returning();
  await db.insert(podHealthEvents).values({
    repoPodId: pod.id,
    repoUrl: pod.poolKey,
    eventType: "crashed",
    podName: `pod-${randomUUID()}`,
    message,
  });
}

beforeAll(async () => {
  ws = (await insertWorkspace()).id;
  owner = await insertUser("Owner");
  other = await insertUser("Other");
  await insertTask({ workspaceId: ws, state: "running" });
  await insertTask({ workspaceId: ws, state: "running", ownerUserId: owner });
  const orgJob = await insertWorkflow({ workspaceId: ws });
  const privateJob = await insertWorkflow({ workspaceId: ws, ownerUserId: owner });
  await insertWorkflowRun(orgJob.id, { state: "completed" });
  await insertWorkflowRun(privateJob.id, { state: "completed" });
  await insertAgent(null);
  await insertAgent(owner);
  await insertCrashedPod(ws, "own workspace crash");
  await insertCrashedPod((await insertWorkspace()).id, "other workspace crash");
});

afterAll(async () => {
  await getRedisClient().quit();
});

async function stats(userId: string, workspaceRole: "admin" | "member") {
  const user = { id: userId, workspaceId: ws, workspaceRole };
  const get = async (routes: (app: FastifyInstance) => Promise<void>, url: string) => {
    const app = await buildRouteTestApp(routes, { user });
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const status = await get(optioRoutes, "/api/optio/system-status");
  return {
    tasks: (await get(taskRoutes, "/api/tasks/stats")).stats.running,
    jobRuns: (await get(workflowRoutes, "/api/jobs/stats")).stats.completed,
    agents: (await get(persistentAgentRoutes, "/api/persistent-agents/stats")).stats.total,
    statusRunning: status.tasks.running,
    alerts: (status.alerts as Array<{ message: string }>).map((a) => a.message),
  };
}

describe("stats count only visible work (integration)", () => {
  it("leaves another member's private work out of a member's counts", async () => {
    expect(await stats(other, "member")).toEqual({
      tasks: 1,
      jobRuns: 1,
      agents: 1,
      statusRunning: 1,
      alerts: ["own workspace crash"],
    });
  });

  it("counts the owner's own private work for them", async () => {
    expect(await stats(owner, "member")).toMatchObject({
      tasks: 2,
      jobRuns: 2,
      agents: 2,
      statusRunning: 2,
    });
  });

  it("counts everything in the workspace for an admin", async () => {
    expect(await stats(other, "admin")).toEqual({
      tasks: 2,
      jobRuns: 2,
      agents: 2,
      statusRunning: 2,
      alerts: ["own workspace crash"],
    });
  });
});
