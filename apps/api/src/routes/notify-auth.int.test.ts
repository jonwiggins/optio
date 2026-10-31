/**
 * Settings → Notifications through the real auth plugin (plugins/auth.ts)
 * and a real session, against real Postgres: a workspace viewer may change
 * their own choices (`/api/notifications/channels` is on the viewers'
 * self-scoped allowlist), and nothing else under /api/notifications — the
 * viewer baseline itself refuses the relay's routes, before the
 * deployment-admin check would.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { db } from "../db/client.js";
import { notifySmtpSettings, workspaceMembers } from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { createSession } from "../services/session-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { notificationRoutes } from "./notifications.js";
import { notifyRoutes } from "./notify.js";

let app: FastifyInstance;
let workspaceId: string;

async function signedIn(role: "viewer" | "member") {
  const externalId = `notify-${randomBytes(4).toString("hex")}`;
  const { token, user } = await createSession("oidc", {
    externalId,
    email: `${externalId}@example.test`,
    displayName: externalId,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role });
  return {
    userId: user.id,
    headers: { authorization: `Bearer ${token}`, "x-workspace-id": workspaceId },
  };
}

const SMTP = {
  host: "relay.example.test",
  port: 25,
  security: "none",
  from: "Optio <optio@example.test>",
};

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  workspaceId = (await insertWorkspace()).id;
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(notificationRoutes);
  await app.register(notifyRoutes);
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

describe("a viewer under the real auth plugin", () => {
  it("reads and changes their own notification choices", async () => {
    const viewer = await signedIn("viewer");
    const read = await app.inject({
      method: "GET",
      url: "/api/notifications/channels",
      headers: viewer.headers,
    });
    expect(read.statusCode).toBe(200);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/notifications/channels",
      headers: viewer.headers,
      payload: { email: { "task.failed": false }, teamWork: false },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().choices).toMatchObject({
      email: { "task.failed": false },
      teamWork: false,
    });
  });

  it("is refused the relay's routes by the viewer baseline", async () => {
    const viewer = await signedIn("viewer");
    for (const [method, url, payload] of [
      ["PUT", "/api/notifications/smtp", SMTP],
      ["DELETE", "/api/notifications/smtp", undefined],
      ["POST", "/api/notifications/smtp/test", { to: "someone@example.test" }],
    ] as const) {
      const res = await app.inject({ method, url, headers: viewer.headers, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      // The baseline's refusal, not the route's own deployment-admin check:
      // a wider allowlist would let the request through to that check.
      expect(res.json().error, `${method} ${url}`).toMatch(/viewers have read-only access/);
    }
    expect(await db.select().from(notifySmtpSettings)).toHaveLength(0);
  });

  it("leaves a member to the route's deployment-admin check", async () => {
    const member = await signedIn("member");
    const res = await app.inject({
      method: "PUT",
      url: "/api/notifications/smtp",
      headers: member.headers,
      payload: SMTP,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/Only a deployment admin/);
  });
});
