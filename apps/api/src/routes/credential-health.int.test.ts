/**
 * Settings → System health and My tokens through the real auth plugin
 * (plugins/auth.ts), real sessions and real Postgres, with a fake LiteLLM on
 * loopback (docs/credential-health.md "Who sees what"):
 *
 *   - a deployment admin sees every credential and may check them all;
 *   - a team admin sees their team's; a team member who isn't one, nothing;
 *   - a workspace admin sees the organization's Jira and Coder connections
 *     of their workspace and the shared token of its gateways (they manage
 *     them), not the deployment's GitLab or gateway tokens, nor another
 *     workspace's;
 *   - everyone sees, and re-checks, their own (a viewer too);
 *   - Check now on someone else's credential is the same 404 as a missing one.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  credentialChecks,
  modelProviders,
  teamMembers,
  teams,
  users,
  workspaceMembers,
} from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { getRedisClient } from "../services/event-bus.js";
import { createModelProvider } from "../services/model-provider-service.js";
import { storeSecret } from "../services/secret-service.js";
import { createSession } from "../services/session-service.js";
import { runCredentialHealthPass } from "../services/credential-health.js";
import { saveCheck } from "../services/credential-health/store.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { credentialHealthRoutes } from "./credential-health.js";

// These tests run with teams on (off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
});

const uniq = () => randomBytes(4).toString("hex");

let app: FastifyInstance;
let server: http.Server;
let workspaceId: string;
let otherWorkspaceId: string;
let teamId: string;
let gatewayId: string;
/** Gateways with a shared (stored) token: this workspace's and another's. */
let sharedHere: string;
let sharedElsewhere: string;

type Person = { userId: string; headers: Record<string, string> };
const people: Record<string, Person> = {};

async function signedIn(name: string, role: "admin" | "member" | "viewer"): Promise<Person> {
  const externalId = `health-${name}-${uniq()}`;
  const { token, user } = await createSession("oidc", {
    externalId,
    email: `${externalId}@example.test`,
    displayName: name,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role });
  return {
    userId: user.id,
    headers: { authorization: `Bearer ${token}`, "x-workspace-id": workspaceId },
  };
}

/** LiteLLM `/key/info` answers, by key. */
const KEYS: Record<string, unknown> = {
  "sk-org": { info: { spend: 1, max_budget: 100, expires: null } },
  "sk-team": { info: { spend: 9, max_budget: 5, budget_reset_at: "2099-01-01T00:00:00Z" } },
  "sk-carol": { info: { spend: 0, max_budget: 5, expires: null } },
  "sk-viewer": { info: { spend: 0, max_budget: 5, expires: null } },
  "sk-shared": { info: { spend: 4.5, max_budget: 5, expires: null } },
};

const get = (who: Person, url = "/api/credential-health") =>
  app.inject({ method: "GET", url, headers: who.headers });
const check = (who: Person, key: string) =>
  app.inject({
    method: "POST",
    url: "/api/credential-health/check",
    headers: who.headers,
    payload: { key },
  });
const keysOf = (res: { json: () => { rows: Array<{ key: string }> } }) =>
  res
    .json()
    .rows.map((r) => r.key)
    .sort();
const gw = (who: string) => `gateway:${gatewayId}:${who}`;

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  vi.stubEnv("OPTIO_SMTP_URL", "");
  vi.stubEnv("GITLAB_TOKEN", "");

  server = http.createServer((req, res) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const body = req.url === "/key/info" ? KEYS[token] : undefined;
    res.writeHead(body ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: { message: "Invalid proxy server token passed" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  workspaceId = (await insertWorkspace()).id;
  otherWorkspaceId = (await insertWorkspace()).id;
  people.operator = await signedIn("operator", "member");
  await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, people.operator.userId));
  people.wsAdmin = await signedIn("ws-admin", "admin");
  people.lead = await signedIn("lead", "member");
  people.bob = await signedIn("bob", "member");
  people.carol = await signedIn("carol", "member");
  people.viewer = await signedIn("viewer", "viewer");

  const [team] = await db
    .insert(teams)
    .values({ workspaceId, name: "Platform", slug: `platform-${uniq()}` })
    .returning();
  teamId = team.id;
  await db.insert(teamMembers).values([
    { teamId, userId: people.lead.userId, role: "admin" },
    { teamId, userId: people.bob.userId, role: "member" },
  ]);
  const [gateway] = await db
    .insert(modelProviders)
    .values({
      workspaceId,
      kind: "gateway",
      name: "LiteLLM",
      agents: ["claude-code"],
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      models: { "claude-code": [{ id: "qwen-internal" }] },
    })
    .returning();
  gatewayId = gateway.id;
  await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-org", "global");
  await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-team", "team", workspaceId, null, teamId);
  await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-carol", "user", null, people.carol.userId);
  await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-viewer", "user", null, people.viewer.userId);
  // A workspace admin's gateway with one shared token (Settings → Model gateway).
  const shared = (ws: string) =>
    createModelProvider(
      {
        kind: "gateway",
        name: "Shared",
        owner: "workspace",
        agents: ["claude-code"],
        baseUrl: gateway.baseUrl!,
        tokenSource: "stored",
        credentials: { type: "bearer-token", bearerToken: "sk-shared" },
      },
      { workspaceId: ws, userId: people.wsAdmin.userId, isAdmin: true },
    );
  sharedHere = (await shared(workspaceId)).id;
  sharedElsewhere = (await shared(otherWorkspaceId)).id;
  await runCredentialHealthPass();
  // The organization's Jira connections, as a pass records them (one here, one elsewhere).
  const jira = (id: string, ws: string) =>
    saveCheck(
      {
        key: `jira:${id}`,
        kind: "jira",
        label: "Jira · jira.example.test",
        scope: "organization",
        workspaceId: ws,
        userId: null,
        teamId: null,
      },
      { status: "ok", reason: null, expiresAt: null, details: { account: "optio-bot" } },
      new Date(),
    );
  await jira("here", workspaceId);
  await jira("elsewhere", otherWorkspaceId);

  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(credentialHealthRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => server.close(r));
  await db.delete(credentialChecks);
  vi.unstubAllEnvs();
  await getRedisClient().quit();
});

describe("who sees which credentials", () => {
  it("a deployment admin sees every one, worst first, and may check them all", async () => {
    const res = await get(people.operator);
    expect(res.statusCode, res.body).toBe(200);
    expect(keysOf(res)).toEqual(
      [
        gw("org"),
        gw(`team:${teamId}`),
        gw(`user:${people.carol.userId}`),
        gw(`user:${people.viewer.userId}`),
        `gateway:${sharedHere}:stored`,
        `gateway:${sharedElsewhere}:stored`,
        "jira:here",
        "jira:elsewhere",
      ].sort(),
    );
    const body = res.json();
    expect(body.canCheckAll).toBe(true);
    expect(body.rows[0]).toMatchObject({
      key: gw(`team:${teamId}`),
      status: "error",
      owner: { name: "Team · Platform", teamId },
    });
    expect(body.rows[0].reason).toContain("Over budget until 2099-01-01 00:00 UTC");
    // Never a token value.
    expect(res.body).not.toMatch(/sk-(org|team|carol|viewer|shared)/);
  });

  it("a team admin sees the team's; a member who isn't its admin, nothing", async () => {
    const lead = await get(people.lead);
    expect(keysOf(lead)).toEqual([gw(`team:${teamId}`)]);
    expect(lead.json().canCheckAll).toBe(false);
    expect(keysOf(await get(people.bob))).toEqual([]);
  });

  it("a workspace admin sees what it manages: its Jira, its gateway's shared token", async () => {
    // Not the deployment's GitLab or gateway tokens, nor another workspace's.
    const res = await get(people.wsAdmin);
    expect(keysOf(res)).toEqual([`gateway:${sharedHere}:stored`, "jira:here"].sort());
    const row = res.json().rows.find((r: { key: string }) => r.key.endsWith(":stored"));
    expect(row).toMatchObject({ scope: "organization", status: "warning" });
    expect(row.reason).toContain("Used 90% of its budget");
    // A member of the workspace doesn't.
    expect(keysOf(await get(people.carol))).not.toContain(`gateway:${sharedHere}:stored`);
  });

  it("everyone sees their own, on the page and on My tokens", async () => {
    expect(keysOf(await get(people.carol))).toEqual([gw(`user:${people.carol.userId}`)]);
    const mine = await get(people.carol, "/api/credential-health?mine=true");
    expect(keysOf(mine)).toEqual([gw(`user:${people.carol.userId}`)]);
    expect(mine.json().rows[0]).toMatchObject({ owner: { name: "carol" }, status: "ok" });
    // A deployment admin's "mine" is theirs alone, not everything.
    expect(keysOf(await get(people.operator, "/api/credential-health?mine=true"))).toEqual([]);
    expect(keysOf(await get(people.viewer))).toEqual([gw(`user:${people.viewer.userId}`)]);
  });
});

describe("Check now", () => {
  it("checks one's own, and refuses anyone else's with the missing one's 404", async () => {
    const own = await check(people.carol, gw(`user:${people.carol.userId}`));
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().row).toMatchObject({ status: "ok", scope: "person" });
    for (const key of [gw("org"), gw(`team:${teamId}`), gw(`user:${people.viewer.userId}`)]) {
      const res = await check(people.carol, key);
      expect(res.statusCode, key).toBe(404);
      expect(res.json().error).toBe("No such credential");
    }
    expect((await check(people.carol, "gitlab:user:nobody")).statusCode).toBe(404);
  });

  it("a team admin checks the team's token; a deployment admin the organization's", async () => {
    const team = await check(people.lead, gw(`team:${teamId}`));
    expect(team.statusCode, team.body).toBe(200);
    expect(team.json().row.status).toBe("error");
    expect((await check(people.bob, gw(`team:${teamId}`))).statusCode).toBe(404);
    expect((await check(people.operator, gw("org"))).statusCode).toBe(200);
  });

  it("a workspace admin checks its gateway's shared token; not another workspace's", async () => {
    const here = await check(people.wsAdmin, `gateway:${sharedHere}:stored`);
    expect(here.statusCode, here.body).toBe(200);
    expect(here.json().row).toMatchObject({ scope: "organization", status: "warning" });
    for (const key of [`gateway:${sharedElsewhere}:stored`, gw("org")]) {
      const res = await check(people.wsAdmin, key);
      expect(res.statusCode, key).toBe(404);
    }
    expect((await check(people.carol, `gateway:${sharedHere}:stored`)).statusCode).toBe(404);
  });

  it("checks a token stored after the last pass (no row yet)", async () => {
    const dave = await signedIn("dave", "member");
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-carol", "user", null, dave.userId);
    expect(keysOf(await get(dave))).toEqual([]);
    const res = await check(dave, gw(`user:${dave.userId}`));
    expect(res.statusCode, res.body).toBe(200);
    expect(keysOf(await get(dave))).toEqual([gw(`user:${dave.userId}`)]);
    const mine = await app.inject({
      method: "POST",
      url: "/api/credential-health/check-mine",
      headers: dave.headers,
    });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().rows.map((r: { key: string }) => r.key)).toEqual([
      gw(`user:${dave.userId}`),
    ]);
  });

  it("a viewer re-checks their own (self-scoped), but can't start a pass", async () => {
    const own = await check(people.viewer, gw(`user:${people.viewer.userId}`));
    expect(own.statusCode, own.body).toBe(200);
    const all = await app.inject({
      method: "POST",
      url: "/api/credential-health/check-all",
      headers: people.viewer.headers,
    });
    expect(all.statusCode).toBe(403);
    expect(all.json().error).toMatch(/viewers have read-only access/);
  });

  it("only a deployment admin starts a pass over everything", async () => {
    for (const who of [people.wsAdmin, people.lead, people.carol]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/credential-health/check-all",
        headers: who.headers,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/Only a deployment admin/);
    }
    const before = new Date();
    const res = await app.inject({
      method: "POST",
      url: "/api/credential-health/check-all",
      headers: people.operator.headers,
    });
    expect(res.statusCode).toBe(202);
    // The pass runs in the background: wait for it to re-record the organization's token.
    const deadline = Date.now() + 10_000;
    let checkedAt = 0;
    while (Date.now() < deadline) {
      const [row] = await db
        .select({ at: credentialChecks.checkedAt })
        .from(credentialChecks)
        .where(eq(credentialChecks.credentialKey, gw("org")));
      checkedAt = row?.at.getTime() ?? 0;
      if (checkedAt >= before.getTime()) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(checkedAt).toBeGreaterThanOrEqual(before.getTime());
  });
});
