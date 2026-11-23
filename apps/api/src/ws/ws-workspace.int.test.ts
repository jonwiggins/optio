/**
 * The web app sends the workspace a page is using on every API call
 * (`x-workspace-id`). Its sockets have to follow the same workspace, not the
 * user's saved default: otherwise a member of two workspaces looking at B
 * (another tab, another device, or after a switch elsewhere) gets B's lists
 * over HTTP, A's live events, and 4403 on every B log stream.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { taskEvents, users, workspaceMembers } from "../db/schema.js";
import { createApiKey } from "../services/api-key-service.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { listenWsApp } from "../test-utils/integration/ws-client.js";
import { eventsWs } from "./events.js";
import { logStreamWs } from "./log-stream.js";

let app: FastifyInstance;
let wsBase: string;
let token: string;
let home: string;
let other: string;
let foreign: string;
const savedAuth = process.env.OPTIO_AUTH_DISABLED;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  home = (await insertWorkspace()).id;
  other = (await insertWorkspace()).id;
  foreign = (await insertWorkspace()).id;
  const [user] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomUUID(),
      email: "two-workspaces@example.test",
      displayName: "Two Workspaces",
      defaultWorkspaceId: home,
    })
    .returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: home, userId: user.id, role: "member" as const },
    { workspaceId: other, userId: user.id, role: "member" as const },
  ]);
  token = (await createApiKey(user.id, "workspace sockets")).token;
  ({ app, wsBase } = await listenWsApp([eventsWs, logStreamWs]));
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await app?.close();
  if (savedAuth === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuth;
});

/** Open a socket naming `workspace` (or none); resolve on open or close. */
function open(path: string, workspace?: string) {
  const protocols = ["optio-ws-v1", `optio-auth-${token}`];
  if (workspace) protocols.push(`optio-workspace-${workspace}`);
  const ws = new WebSocket(`${wsBase}${path}`, protocols);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") frames.push(JSON.parse(ev.data));
  };
  const outcome = new Promise<{ opened: boolean; code?: number }>((resolve) => {
    ws.onopen = () => {
      // A refused socket is accepted and then closed; give it a moment.
      setTimeout(() => resolve({ opened: ws.readyState === WebSocket.OPEN }), 500);
    };
    ws.onclose = (ev) => resolve({ opened: false, code: ev.code });
  });
  return { ws, frames, outcome };
}

describe("sockets follow the workspace the page names", () => {
  it("streams a task's logs in the named workspace, not only in the saved default", async () => {
    const task = await insertTask({ workspaceId: other });
    expect((await open(`/ws/logs/${task.id}`, other).outcome).opened).toBe(true);
    // Without a name the saved default still applies, and B's task is refused there.
    expect((await open(`/ws/logs/${task.id}`).outcome).code).toBe(4403);
  });

  it("sends the named workspace's state changes on the events socket", async () => {
    const inOther = await insertTask({ workspaceId: other });
    const inHome = await insertTask({ workspaceId: home });
    await db.insert(taskEvents).values(
      [inOther, inHome].map((t) => ({
        taskId: t.id,
        fromState: "pending" as const,
        toState: "queued" as const,
        trigger: "test",
      })),
    );
    const socket = open("/ws/events", other);
    expect((await socket.outcome).opened).toBe(true);
    const ids = socket.frames.map((f) => f.taskId);
    expect(ids).toContain(inOther.id);
    expect(ids).not.toContain(inHome.id);
  });

  it("refuses a workspace the user does not belong to, without falling back", async () => {
    expect((await open("/ws/events", foreign).outcome).code).toBe(4403);
    expect((await open("/ws/events", "not-a-uuid").outcome).code).toBe(4403);
  });
});
