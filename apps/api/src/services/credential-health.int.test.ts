/**
 * Credential health against real Postgres and Redis (docs/credential-health.md),
 * with a fake GitLab and a fake LiteLLM on loopback: the worker's pass
 * (under its lease) records every token with its status and reason, warns
 * each owner once per threshold — a person, a team's admins, the deployment
 * admins — keeps a warning due while email isn't set up, drops the rows of
 * credentials that are gone, and the gateway pre-flight fails a run before
 * its pod with whose token it is, until when, and where to fix it. A
 * GitLab token goes only to a GitLab a deployment admin named (never to a
 * host only a repo names), and an expired LiteLLM key is known by LiteLLM's
 * own refusal. A warning a team's channel took, or one for people nothing can
 * reach, is done; one for someone waiting for the relay stays due.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { classifyError } from "@optio/shared";
import { db } from "../db/client.js";
import {
  credentialChecks,
  modelProviders,
  notifyChatHooks,
  notifySmtpSettings,
  repos,
  secrets,
  teamMembers,
  teams,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { insertRepo, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { getRedisClient } from "./event-bus.js";
import { storeSecret } from "./secret-service.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./notify/email.js";
import {
  createMemoryChatTransport,
  setChatTransportForTests,
  setPersonalHook,
  setTeamChannel,
} from "./notify/chat-hooks.js";
import {
  checkCredentialNow,
  credentialHealthTick,
  runCredentialHealthPass,
} from "./credential-health.js";
import { setCredentialHealthFetchForTests } from "./credential-health/checks.js";
import { GatewayPreflightError } from "./credential-health/gateway-preflight.js";
import { resolveGatewayRun } from "./gateway-run-service.js";
import { createModelProvider, ModelProviderError } from "./model-provider-service.js";
import { recordGatewayError } from "../telemetry/site-metrics.js";

// These tests run with teams on and gateway-only model access (both off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
  process.env.OPTIO_MODEL_ACCESS = "gateway";
});

// The deployment's monitoring counts each pre-flight refusal (telemetry/site-metrics.ts).
vi.mock("../telemetry/site-metrics.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../telemetry/site-metrics.js")>();
  return { ...mod, recordGatewayError: vi.fn(mod.recordGatewayError) };
});

const uniq = () => randomBytes(4).toString("hex");
const DAY = 86_400_000;
const isoIn = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const dateIn = (days: number) => isoIn(days).slice(0, 10);
const mail = createMemoryEmailTransport();
const chat = createMemoryChatTransport();

// ── The fake GitLab and LiteLLM ──────────────────────────────────────────────

type Reply = { status: number; body: unknown };
const servers: http.Server[] = [];
async function serve(route: (req: http.IncomingMessage) => Reply): Promise<string> {
  const server = http.createServer((req, res) => {
    const r = route(req);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stand-in that writes its own answer (headers included). */
async function serveRaw(
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** GitLab's answers, by token. */
const gitlabTokens: Record<string, Reply> = {
  // The organization's: 5 days left, and only a Developer on the webhook project.
  "glpat-org": {
    status: 200,
    body: {
      name: "optio",
      scopes: ["api"],
      active: true,
      revoked: false,
      expires_at: dateIn(5),
      user_id: 7,
    },
  },
  "glpat-alice": {
    status: 200,
    body: {
      name: "mine",
      scopes: ["api"],
      active: true,
      revoked: false,
      expires_at: dateIn(120),
      user_id: 8,
    },
  },
  "glpat-team": {
    status: 401,
    body: { error: "invalid_token", error_description: "Token has expired." },
  },
};

/** LiteLLM's answers to /key/info, by key. */
const litellmKeys: Record<string, Reply> = {
  "sk-org": {
    status: 200,
    body: { key: "h", info: { spend: 0.5, max_budget: 100, expires: null } },
  },
  "sk-alice": {
    status: 200,
    body: { key: "h", info: { spend: 0.1, max_budget: 5, expires: isoIn(0.9) } },
  },
  "sk-bob-over": {
    status: 200,
    body: {
      key: "h",
      info: { spend: 1.5, max_budget: 1, budget_reset_at: "2099-11-01T00:00:00Z", expires: null },
    },
  },
  // A LiteLLM that checks the budget on /key/info too: no info, just the refusal.
  "sk-carol-over": {
    status: 400,
    body: {
      error: {
        message: "Budget has been exceeded! Current cost: 2.5, Max budget: 2.0",
        type: "budget_exceeded",
        param: null,
        code: "400",
      },
    },
  },
  // LiteLLM authenticates /key/info too: an expired key gets its refusal, never its info.
  "sk-expired": {
    status: 400,
    body: {
      error: {
        message:
          "Authentication Error - Expired Key. Key Expiry time 2026-10-20 08:30:00.123456+00:00 and current time 2026-10-24 12:00:00.000001+00:00",
        type: "expired_key",
        param: "sk-expired",
        code: "400",
      },
    },
  },
  // A key the gateway's admin blocked: /key/info still answers 200, with `blocked`.
  "sk-blocked": {
    status: 200,
    body: { key: "h", info: { spend: 0, max_budget: 5, blocked: true, expires: null } },
  },
  "sk-team-bad": {
    status: 401,
    body: {
      error: {
        message:
          "Authentication Error, Invalid proxy server token passed. Received API Key = sk-...-bad",
      },
    },
  },
};

let gatewayUrl = "";
/** Every GitLab token a host nobody named was sent. */
const gitlabTokenOf = (req: http.IncomingMessage) =>
  String(req.headers["private-token"] ?? req.headers.authorization ?? "").replace(/^Bearer /, "");
const collected: string[] = [];

beforeAll(async () => {
  // A host only a repo names: it accepts anything, and keeps what it got.
  const collector = await serve((req) => {
    collected.push(gitlabTokenOf(req));
    return {
      status: 200,
      body: { name: "x", scopes: ["api"], active: true, revoked: false, user_id: 1 },
    };
  });
  const gitlab = await serve((req) => {
    const token = gitlabTokenOf(req);
    const url = req.url ?? "";
    if (url === "/api/v4/personal_access_tokens/self") {
      return gitlabTokens[token] ?? { status: 401, body: { message: "401 Unauthorized" } };
    }
    if (url === `/api/v4/projects/${encodeURIComponent("platform/app")}`) {
      return { status: 200, body: { permissions: { project_access: { access_level: 30 } } } };
    }
    return { status: 404, body: { message: "404 Not Found" } };
  });
  // A GitHub Enterprise Server: GET /api/v3/user, the expiry in a header.
  const ghe = await serveRaw((req, res) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (req.url === "/api/v3/user" && token === "ghp-team") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "github-authentication-token-expiration": `${dateIn(3)} 00:00:00 UTC`,
      });
      res.end(JSON.stringify({ login: "platform-bot" }));
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Bad credentials" }));
  });
  setCredentialHealthFetchForTests((url, init) =>
    fetch(
      url
        .replace("https://gitlab.test", gitlab)
        .replace("https://collector.example.test", collector)
        .replace("https://ghe.example.test", ghe),
      init,
    ),
  );
  gatewayUrl = await serve((req) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (req.url === "/key/info") {
      return litellmKeys[token] ?? { status: 401, body: { error: { message: "Invalid key" } } };
    }
    return { status: 404, body: {} };
  });
  setEmailTransportForTests(mail);
  setChatTransportForTests(chat);
});

afterAll(async () => {
  setCredentialHealthFetchForTests(null);
  setEmailTransportForTests(null);
  setChatTransportForTests(null);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await getRedisClient().quit();
});

beforeEach(async () => {
  mail.sent.length = 0;
  chat.posts.length = 0;
  collected.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv("GITLAB_HOSTS", "gitlab.test");
  vi.stubEnv("GITLAB_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "Optio <optio@example.test>");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
  await db.delete(notifySmtpSettings);
  await db.delete(credentialChecks);
  await db.delete(secrets);
  await db.delete(modelProviders);
  await db.delete(repos);
});

async function person(name: string, deploymentAdmin = false) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
      deploymentAdmin,
    })
    .returning();
  return row;
}

/** A workspace with people, the Platform team, a gateway and a token of every kind. */
async function seed() {
  const ws = await insertWorkspace();
  const [operator, alice, bob, lead] = await Promise.all([
    person("operator", true),
    person("alice"),
    person("bob"),
    person("lead"),
  ]);
  await db.insert(workspaceMembers).values([
    { workspaceId: ws.id, userId: operator.id, role: "admin" },
    { workspaceId: ws.id, userId: alice.id, role: "member" },
    { workspaceId: ws.id, userId: bob.id, role: "member" },
    { workspaceId: ws.id, userId: lead.id, role: "member" },
  ]);
  const [team] = await db
    .insert(teams)
    .values({ workspaceId: ws.id, name: "Platform", slug: `platform-${uniq()}` })
    .returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, userId: lead.id, role: "admin" },
    { teamId: team.id, userId: bob.id, role: "member" },
  ]);
  await insertRepo({
    workspaceId: ws.id,
    repoUrl: "https://gitlab.test/platform/app",
    fullName: "platform/app",
    gitPlatform: "gitlab",
    webhookId: "12",
  });
  const [gateway] = await db
    .insert(modelProviders)
    .values({
      workspaceId: ws.id,
      kind: "gateway",
      name: "LiteLLM",
      agents: ["claude-code"],
      baseUrl: gatewayUrl,
      models: { "claude-code": [{ id: "qwen-internal" }] },
    })
    .returning();
  await storeSecret("GITLAB_TOKEN", "glpat-org", "global");
  await storeSecret("GITLAB_TOKEN", "glpat-alice", "user", null, alice.id);
  await storeSecret("GITLAB_TOKEN", "glpat-team", "team", ws.id, null, team.id);
  await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-org", "global");
  await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-alice", "user", null, alice.id);
  await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-bob-over", "user", null, bob.id);
  await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-team-bad", "team", ws.id, null, team.id);
  return { ws, team, gateway, operator, alice, bob, lead };
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function rows() {
  const all = await db.select().from(credentialChecks);
  return new Map(all.map((r) => [r.credentialKey, r]));
}

/** The emails this seed's people got, as `address: subject`. */
function mailFor(s: Seed): string[] {
  const names = new Map(
    [s.operator, s.alice, s.bob, s.lead].map((p) => [p.email, p.displayName] as const),
  );
  return mail.sent
    .filter((m) => names.has(m.to[0]))
    .map((m) => `${names.get(m.to[0])}: ${m.subject}`)
    .sort();
}

describe("the worker's pass", () => {
  it("records every token with its status, reason and expiry", async () => {
    const s = await seed();
    const result = await credentialHealthTick();
    expect(result?.checked).toBe(7);
    const r = await rows();
    const gw = (who: string) => r.get(`gateway:${s.gateway.id}:${who}`);

    const org = r.get("gitlab:org")!;
    expect(org).toMatchObject({ scope: "organization", status: "warning" });
    expect(org.reason).toContain("Expires in 5 days");
    expect(org.reason).toContain("Not Maintainer on platform/app");
    expect(org.expiresAt?.toISOString()).toBe(`${dateIn(5)}T00:00:00.000Z`);

    expect(r.get(`gitlab:user:${s.alice.id}`)).toMatchObject({
      scope: "person",
      userId: s.alice.id,
      status: "ok",
    });
    const teamGitlab = r.get(`gitlab:team:${s.team.id}`)!;
    expect(teamGitlab).toMatchObject({ scope: "team", teamId: s.team.id, status: "error" });
    expect(teamGitlab.reason).toBe(
      "GitLab at gitlab.test refused it (401: Token has expired.): expired, revoked or wrong",
    );

    expect(gw("org")).toMatchObject({ status: "ok", scope: "organization" });
    expect(gw(`user:${s.alice.id}`)!.reason).toMatch(/^Expires in 1 day/);
    const bob = gw(`user:${s.bob.id}`)!;
    expect(bob.status).toBe("error");
    expect(bob.reason).toBe("Over budget until 2099-11-01 00:00 UTC: 1.50 of 1.00 USD spent");
    expect(bob.details).toMatchObject({ spend: 1.5, maxBudget: 1 });
    const team = gw(`team:${s.team.id}`)!;
    expect(team.reason).toBe(
      "Rejected by the gateway (401: Authentication Error, Invalid proxy server token passed)",
    );
    // No row ever holds a token.
    expect(JSON.stringify([...r.values()])).not.toMatch(/glpat-|sk-(org|alice|bob|team)/);
  });

  it("warns each owner once per threshold: a person, the team's admins, the deployment admins", async () => {
    const s = await seed();
    await runCredentialHealthPass();
    expect(mailFor(s)).toEqual(
      [
        "alice: [Optio] Your gateway token expires in 1 day",
        "bob: [Optio] Your gateway token is over budget",
        "lead: [Optio] The Platform team's GitLab token stopped working",
        "lead: [Optio] The Platform team's gateway token stopped working",
        "operator: [Optio] The organization's GitLab token expires in 5 days",
      ].sort(),
    );
    const bobMail = mail.sent.find((m) => m.to[0] === s.bob.email)!;
    expect(bobMail.text).toContain("2099-11-01 00:00 UTC");
    expect(bobMail.text).toContain("Fix it under Settings → My tokens");
    expect(bobMail.headers).toMatchObject({ "X-Optio-Event": "budget.exceeded" });

    // The next passes: nothing new.
    mail.sent.length = 0;
    await runCredentialHealthPass();
    await runCredentialHealthPass();
    expect(mailFor(s)).toEqual([]);
    const org = (await rows()).get("gitlab:org")!;
    expect(Object.keys(org.notified).sort()).toEqual(
      [`expiry:30:${dateIn(5)}`, `expiry:7:${dateIn(5)}`].sort(),
    );
  });

  it("keeps the warnings due while email isn't set up, and sends them once it is", async () => {
    const s = await seed();
    vi.stubEnv("OPTIO_SMTP_URL", "");
    await runCredentialHealthPass();
    expect(mailFor(s)).toEqual([]);
    expect((await rows()).get(`gateway:${s.gateway.id}:user:${s.bob.id}`)!.notified).toEqual({});
    vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
    await runCredentialHealthPass();
    expect(mailFor(s)).toContain("bob: [Optio] Your gateway token is over budget");
  });

  it("an expired gateway key is failing, says when it expired, and its owner hears once", async () => {
    const s = await seed();
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-expired", "user", null, s.alice.id);
    await runCredentialHealthPass();
    const row = (await rows()).get(`gateway:${s.gateway.id}:user:${s.alice.id}`)!;
    expect(row).toMatchObject({ status: "error", reason: "Expired on 2026-10-20 08:30 UTC" });
    expect(row.expiresAt?.toISOString()).toBe("2026-10-20T08:30:00.123Z");
    expect(JSON.stringify(row)).not.toContain("sk-expired");
    expect(mailFor(s)).toContain("alice: [Optio] Your gateway token stopped working");
    mail.sent.length = 0;
    await runCredentialHealthPass();
    expect(mailFor(s)).toEqual([]);
  });

  it("a workspace gateway's shared token: its workspace's admins see it and hear about it", async () => {
    const s = await seed();
    const wsAdmin = await person("ws-admin");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: s.ws.id, userId: wsAdmin.id, role: "admin" });
    // Made the way a workspace admin makes it (Settings → Model gateway).
    const shared = await createModelProvider(
      {
        kind: "gateway",
        name: "Shared",
        owner: "workspace",
        agents: ["claude-code"],
        baseUrl: gatewayUrl,
        tokenSource: "stored",
        credentials: { type: "bearer-token", bearerToken: "sk-alice" },
      },
      { workspaceId: s.ws.id, userId: wsAdmin.id, isAdmin: true },
    );
    await runCredentialHealthPass();
    const row = (await rows()).get(`gateway:${shared.id}:stored`)!;
    expect(row).toMatchObject({ scope: "organization", workspaceId: s.ws.id, status: "warning" });
    // sk-alice expires within a day: the workspace's admins and the deployment
    // admins hear, each once (operator is both).
    const subject = "[Optio] The organization's gateway token expires in 1 day";
    const to = (who: { email: string }) =>
      mail.sent.filter((m) => m.to[0] === who.email && m.subject === subject).length;
    expect(to(wsAdmin)).toBe(1);
    expect(to(s.operator)).toBe(1);
    expect(to(s.alice)).toBe(0);
    expect(mail.sent.find((m) => m.to[0] === wsAdmin.email)!.text).toContain(
      "Fix it under Settings → Model gateway",
    );
  });

  it("a replaced token is checked again under the same row; a removed one loses its row", async () => {
    const s = await seed();
    await runCredentialHealthPass();
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-org", "user", null, s.bob.id);
    const fixed = await checkCredentialNow(`gateway:${s.gateway.id}:user:${s.bob.id}`);
    expect(fixed).toMatchObject({ status: "ok", reason: null });
    // Fixed: the budget marker goes, so the next overrun is news again.
    expect(fixed!.notified).toEqual({});

    await db.delete(secrets).where(eq(secrets.userId, s.alice.id));
    await runCredentialHealthPass();
    const r = await rows();
    expect(r.has(`gitlab:user:${s.alice.id}`)).toBe(false);
    expect(r.has(`gateway:${s.gateway.id}:user:${s.alice.id}`)).toBe(false);
    expect(r.has("gitlab:org")).toBe(true);
    expect(await checkCredentialNow(`gitlab:user:${s.alice.id}`)).toBeNull();
  });
});

describe("warnings to a team's channel, and to people no channel reaches", () => {
  it("a team channel that takes the warning gets it once, though the team's admin can't be reached", async () => {
    const s = await seed();
    const channel = `https://chat.example.test/hooks/platform-${uniq()}`;
    await setTeamChannel(s.team, s.lead.id, {
      url: channel,
      format: "mattermost",
      events: ["token.invalid", "token.expiring", "budget.exceeded"],
    });
    // The team's only admin has no usable address and no hook of their own; no relay.
    await db.update(users).set({ email: "not-an-address" }).where(eq(users.id, s.lead.id));
    vi.stubEnv("OPTIO_SMTP_URL", "");
    try {
      const posted = () =>
        chat.posts
          .filter((p) => p.url === channel)
          .map((p) => String(p.body.text).split("\n")[0])
          .sort();
      await runCredentialHealthPass();
      const first = posted();
      expect(first).toHaveLength(2);
      expect(first[0]).toContain("GitLab token stopped working");
      expect(first[1]).toContain("gateway token stopped working");
      // The next passes post nothing again: the warnings are marked sent.
      await runCredentialHealthPass();
      await runCredentialHealthPass();
      expect(posted()).toEqual(first);
      const r = await rows();
      expect(r.get(`gitlab:team:${s.team.id}`)!.notified).toHaveProperty("invalid");
      expect(r.get(`gateway:${s.gateway.id}:team:${s.team.id}`)!.notified).toHaveProperty(
        "invalid",
      );
    } finally {
      await db.delete(notifyChatHooks).where(eq(notifyChatHooks.ownerTeamId, s.team.id));
    }
  });

  it("a warning for someone with no address and no hook is done, as before chat hooks", async () => {
    const s = await seed();
    await db.update(users).set({ email: "not-an-address" }).where(eq(users.id, s.bob.id));
    const key = `gateway:${s.gateway.id}:user:${s.bob.id}`;
    await runCredentialHealthPass();
    const first = (await rows()).get(key)!;
    expect(Object.keys(first.notified)).toEqual([expect.stringMatching(/^budget:/)]);
    await runCredentialHealthPass();
    expect((await rows()).get(key)!.notified).toEqual(first.notified);
    expect(mail.sent.filter((m) => /over budget/.test(m.subject))).toEqual([]);
  });

  it("with a chat hook but no relay, a warning for someone with an address and no hook stays due until the relay is set", async () => {
    const s = await seed();
    // alice has a hook, so chat is on and the pass sends what it can.
    const aliceHook = `https://chat.example.test/hooks/alice-${uniq()}`;
    await setPersonalHook(s.alice.id, { url: aliceHook, format: "mattermost" });
    vi.stubEnv("OPTIO_SMTP_URL", "");
    try {
      const key = `gateway:${s.gateway.id}:user:${s.bob.id}`;
      await runCredentialHealthPass();
      expect(chat.posts.some((p) => p.url === aliceHook)).toBe(true);
      expect((await rows()).get(key)!.notified).toEqual({});
      vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
      await runCredentialHealthPass();
      expect(mailFor(s)).toContain("bob: [Optio] Your gateway token is over budget");
      expect(Object.keys((await rows()).get(key)!.notified)).toEqual([
        expect.stringMatching(/^budget:/),
      ]);
    } finally {
      await db.delete(notifyChatHooks).where(eq(notifyChatHooks.ownerUserId, s.alice.id));
    }
  });
});

describe("which GitLab a token is sent to", () => {
  it("never to a host only a repo names, in another workspace or the owner's own", async () => {
    const s = await seed();
    // Any workspace admin adds a repo, on any host.
    const other = await insertWorkspace();
    await insertRepo({
      workspaceId: other.id,
      repoUrl: "https://collector.example.test/x/y",
      fullName: "x/y",
      gitPlatform: "gitlab",
      webhookId: "13",
    });
    await insertRepo({
      workspaceId: s.ws.id,
      repoUrl: "https://collector.example.test/a/b",
      fullName: "a/b",
      gitPlatform: "gitlab",
    });
    await runCredentialHealthPass();
    expect(collected).toEqual([]);
    const r = await rows();
    // Refused by the named GitLab: not tried anywhere else.
    expect(r.get(`gitlab:team:${s.team.id}`)!.reason).toBe(
      "GitLab at gitlab.test refused it (401: Token has expired.): expired, revoked or wrong",
    );
    expect(r.get(`gitlab:user:${s.alice.id}`)!.status).toBe("ok");
    expect(r.get("gitlab:org")!.status).toBe("warning");
  });

  it("of the named GitLabs, only those the owner's work uses", async () => {
    const s = await seed();
    vi.stubEnv("GITLAB_HOSTS", "gitlab.test,collector.example.test");
    const other = await insertWorkspace();
    await insertRepo({
      workspaceId: other.id,
      repoUrl: "https://collector.example.test/x/y",
      fullName: "x/y",
      gitPlatform: "gitlab",
    });
    const carol = await person("carol");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: other.id, userId: carol.id, role: "member" });
    await storeSecret("GITLAB_TOKEN", "glpat-carol", "user", null, carol.id);
    await runCredentialHealthPass();
    // carol works there; the Platform team's refused token and alice's don't go there.
    expect(collected).toEqual(["glpat-carol"]);
    expect((await rows()).get(`gitlab:team:${s.team.id}`)!.status).toBe("error");
  });

  it("a repo's host is never enough on its own; the setup wizard's GITLAB_HOST is", async () => {
    const s = await seed();
    vi.stubEnv("GITLAB_HOSTS", "");
    await runCredentialHealthPass();
    let alice = (await rows()).get(`gitlab:user:${s.alice.id}`)!;
    expect(alice.status).toBe("unknown");
    expect(alice.reason).toContain("gitlab.hosts");
    await storeSecret("GITLAB_HOST", "https://gitlab.test", "global");
    await runCredentialHealthPass();
    alice = (await rows()).get(`gitlab:user:${s.alice.id}`)!;
    expect(alice).toMatchObject({ status: "ok", details: { host: "gitlab.test" } });
    expect(collected).toEqual([]);
  });
});

describe("GitHub tokens", () => {
  it("are asked on the GitHub of their owner's repos; one GitHub refuses is failing", async () => {
    const s = await seed();
    await insertRepo({
      workspaceId: s.ws.id,
      repoUrl: "https://ghe.example.test/platform/api",
      fullName: "platform/api",
      gitPlatform: "github",
    });
    await storeSecret("GITHUB_TOKEN", "ghp-team", "team", s.ws.id, null, s.team.id);
    await storeSecret("GITHUB_TOKEN", "ghp-alice-revoked", "user", null, s.alice.id);
    await runCredentialHealthPass();
    const r = await rows();
    expect(r.get(`github:team:${s.team.id}`)).toMatchObject({
      kind: "github",
      status: "warning",
      details: { host: "ghe.example.test", account: "platform-bot" },
    });
    expect(r.get(`github:team:${s.team.id}`)!.expiresAt).not.toBeNull();
    expect(r.get(`github:user:${s.alice.id}`)).toMatchObject({ kind: "github", status: "error" });
    expect(collected).toEqual([]);
  });
});

describe("the gateway pre-flight", () => {
  const run = (s: Seed, owner: { ownerUserId?: string; ownerTeamId?: string }) =>
    resolveGatewayRun({
      agentType: "claude-code",
      agentOptions: {},
      workspaceId: s.ws.id,
      ownerUserId: owner.ownerUserId ?? null,
      ownerTeamId: owner.ownerTeamId ?? null,
    });

  it("fails bob's run before any pod: over budget until the reset, and where to fix it", async () => {
    const s = await seed();
    const err = await run(s, { ownerUserId: s.bob.id }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayPreflightError);
    // A model provider's refusal: the task worker fails the run at once, no provisioning retry.
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.message).toBe(
      "Your gateway token is over budget until 2099-11-01 00:00 UTC (1.50 of 1.00 USD spent) — Settings → My tokens",
    );
    const classified = classifyError(err.message);
    expect(classified.title).toBe("Gateway budget used up");
    expect(classified.retryable).toBe(false);
    // The System health row shows it at once, without waiting for a pass.
    const row = (await rows()).get(`gateway:${s.gateway.id}:user:${s.bob.id}`)!;
    expect(row).toMatchObject({ status: "error", scope: "person", userId: s.bob.id });
    // Counted as a spent budget (/key/info answered 200 with the spend).
    expect(vi.mocked(recordGatewayError)).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 429, ownerUserId: s.bob.id, source: "preflight" }),
    );
  });

  it("names the team and its Tokens page when the gateway rejects the team's token", async () => {
    const s = await seed();
    const err = await run(s, { ownerUserId: s.lead.id, ownerTeamId: s.team.id }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayPreflightError);
    expect(err.message).toBe(
      "The Platform team's gateway token was rejected by the gateway (401: Authentication Error, Invalid proxy server token passed) — put in a new one under Teams → Platform → Tokens",
    );
    expect(classifyError(err.message).title).toBe("Gateway token rejected");
    expect(classifyError(err.message).remedy).toContain("Teams → Platform → Tokens");
    // Counted for the deployment's monitoring: the status, the team, never the token.
    expect(vi.mocked(recordGatewayError)).toHaveBeenLastCalledWith({
      status: 401,
      model: expect.any(String),
      ownerTeamId: s.team.id,
      ownerUserId: s.lead.id,
      source: "preflight",
    });
  });

  it("lets a working token through (expiring isn't refused), and can be turned off", async () => {
    const s = await seed();
    vi.mocked(recordGatewayError).mockClear();
    const ok = await run(s, { ownerUserId: s.alice.id });
    expect(ok?.token).toBe("sk-alice");
    expect(vi.mocked(recordGatewayError)).not.toHaveBeenCalled();
    vi.stubEnv("OPTIO_GATEWAY_PREFLIGHT", "false");
    const unchecked = await run(s, { ownerUserId: s.bob.id });
    expect(unchecked?.token).toBe("sk-bob-over");
  });

  it("knows an over-budget key from LiteLLM's refusal when /key/info is refused too", async () => {
    const s = await seed();
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-carol-over", "user", null, s.alice.id);
    const err = await run(s, { ownerUserId: s.alice.id }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayPreflightError);
    expect(err.message).toBe(
      "Your gateway token is over budget (2.50 of 2.00 USD spent); the gateway refuses it until its budget resets or is raised — Settings → My tokens",
    );
    expect(classifyError(err.message).title).toBe("Gateway budget used up");
    const row = (await rows()).get(`gateway:${s.gateway.id}:user:${s.alice.id}`)!;
    expect(row).toMatchObject({ status: "error" });
    expect(row.reason).toContain("doesn't say when it resets");
    // LiteLLM's 400 `budget_exceeded`, counted as the spent budget it is.
    expect(vi.mocked(recordGatewayError)).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 429, source: "preflight" }),
    );
  });

  it("counts a key the gateway blocked (a 200 from /key/info) as the refused token it is, not a budget", async () => {
    const s = await seed();
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-blocked", "user", null, s.alice.id);
    vi.mocked(recordGatewayError).mockClear();
    const err = await run(s, { ownerUserId: s.alice.id }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayPreflightError);
    expect(err.message).toBe(
      "Your gateway token is blocked on the gateway — ask its admin, or put in a new one under Settings → My tokens",
    );
    // OptioGatewayRefusing reads 401 / 403 as a dead token and 429 as a
    // rate limit or a budget: a blocked key is the former.
    expect(vi.mocked(recordGatewayError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordGatewayError)).toHaveBeenLastCalledWith({
      status: 401,
      model: expect.any(String),
      ownerTeamId: null,
      ownerUserId: s.alice.id,
      source: "preflight",
    });
  });

  it("fails a run whose key LiteLLM refuses as expired, saying since when", async () => {
    const s = await seed();
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-expired", "user", null, s.alice.id);
    const err = await run(s, { ownerUserId: s.alice.id }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayPreflightError);
    expect(err.message).toBe(
      "Your gateway token expired on 2026-10-20 08:30 UTC and is rejected by the gateway — put in a new one under Settings → My tokens",
    );
    expect(classifyError(err.message).title).toBe("Gateway token rejected");
    expect(classifyError(err.message).remedy).toContain("Settings → My tokens");
    // LiteLLM's 400 `expired_key`: a dead token, counted as 401 for the alert.
    expect(vi.mocked(recordGatewayError)).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 401, ownerUserId: s.alice.id, source: "preflight" }),
    );
    const row = (await rows()).get(`gateway:${s.gateway.id}:user:${s.alice.id}`)!;
    expect(row).toMatchObject({ status: "error", reason: "Expired on 2026-10-20 08:30 UTC" });
  });

  it("lets the run try when the gateway can't be reached", async () => {
    const s = await seed();
    await db
      .update(modelProviders)
      .set({ baseUrl: "http://127.0.0.1:9" })
      .where(eq(modelProviders.id, s.gateway.id));
    const r = await run(s, { ownerUserId: s.bob.id });
    expect(r?.token).toBe("sk-bob-over");
  });
});
