/**
 * Credential health against real Postgres (services/credential-health/):
 * which token goes where, the warnings and how often, who sees which row,
 * and the gateway pre-flight. The gateways and GitLab are stand-ins that
 * record every request (URL and credential headers).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { credentialChecks, users, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  createModelProvider,
  getModelProviderRow,
  updateModelProvider,
  type ProviderViewer,
} from "./model-provider-service.js";
import {
  setGatewayFetchForTests,
  storeOrganizationGatewayToken,
  storePersonalGatewayToken,
} from "./model-gateway-service.js";
import { resolveGatewayRun } from "./gateway-run-service.js";
import { storeSecret } from "./secret-service.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./notify/email.js";
import { closeOutboxQueue, setOutboxActive } from "./notify/outbox.js";
import { setCredentialHealthFetchForTests } from "./credential-health/checks.js";
import { checkMine, runCredentialPass } from "./credential-health/run.js";
import { listChecks } from "./credential-health/store.js";
import { GatewayPreflightError } from "./credential-health/gateway-preflight.js";

const mail = createMemoryEmailTransport();
/** The subjects sent, without the "[Optio] " prefix. */
const subjects = () => mail.sent.map((m) => m.subject.replace(/^\[Optio\] /, ""));
const NOW = new Date("2026-10-24T12:00:00Z");

/** Every request a stand-in got: where, and which credential it carried. */
let sent: Array<{ url: string; auth: string | null }>;
/** The gateway's answer to /key/info per token. */
let keyInfo: Record<string, unknown>;

function record(url: string, init?: RequestInit) {
  const h = new Headers(init?.headers);
  sent.push({ url, auth: h.get("authorization") ?? h.get("x-portkey-api-key") });
  return h.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomUUID(),
      email: `${name}.${randomUUID().slice(0, 6)}@example.test`,
      displayName: name,
      emailVerified: true,
    })
    .returning();
  return row;
}

let ws: string;
let admin: ProviderViewer;
let alice: ProviderViewer;
let bob: ProviderViewer;

beforeEach(async () => {
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "optio@example.test");
  setEmailTransportForTests(mail);
  mail.sent.length = 0;
  setOutboxActive(false);
  sent = [];
  keyInfo = {};
  setGatewayFetchForTests(async (url, init) => {
    const token = record(url, init);
    if (new URL(url).pathname.endsWith("/key/info")) {
      const info = keyInfo[token];
      return info ? Response.json({ info }) : Response.json({ error: "nope" }, { status: 401 });
    }
    return Response.json({ data: [{ id: "m" }] });
  });
  setCredentialHealthFetchForTests(async (url, init) => {
    record(url, init);
    return Response.json({
      name: "optio",
      scopes: ["api"],
      active: true,
      expires_at: "2026-10-31",
    });
  });
  ws = (await insertWorkspace()).id;
  const [a, al, b] = await Promise.all(["admin", "alice", "bob"].map(person));
  await db.insert(workspaceMembers).values([
    { workspaceId: ws, userId: a.id, role: "admin" },
    { workspaceId: ws, userId: al.id, role: "member" },
    { workspaceId: ws, userId: b.id, role: "member" },
  ]);
  admin = { workspaceId: ws, userId: a.id, isAdmin: true };
  alice = { workspaceId: ws, userId: al.id, isAdmin: false };
  bob = { workspaceId: ws, userId: b.id, isAdmin: false };
});

afterEach(async () => {
  setGatewayFetchForTests(null);
  setCredentialHealthFetchForTests(null);
  vi.unstubAllEnvs();
  await db.delete(credentialChecks);
});

afterAll(async () => {
  setEmailTransportForTests(null);
  await closeOutboxQueue();
});

const litellm = (name: string, baseUrl: string) =>
  createModelProvider(
    {
      name,
      owner: "workspace",
      kind: "gateway",
      gatewayType: "litellm",
      agents: ["claude-code"],
      baseUrl,
      models: { "claude-code": [{ id: "m" }] },
    },
    admin,
  );

describe("credential health", () => {
  it("sends a person's gateway token only to the gateway it was given for", async () => {
    const a = await litellm("A", "https://a.example.com");
    await storePersonalGatewayToken(alice, "alice-for-a", a.id);
    keyInfo["alice-for-a"] = { spend: 1, max_budget: 10 };
    // An admin adds a second gateway, pointing somewhere else: Alice never gave it a token.
    await litellm("B", "https://b.example.com");
    sent = [];
    await runCredentialPass({ now: NOW, force: true });
    const toB = sent.filter((s) => s.url.startsWith("https://b.example.com"));
    expect(toB).toEqual([]);
    expect(
      sent.filter((s) => s.auth === "Bearer alice-for-a").map((s) => new URL(s.url).host),
    ).toEqual(["a.example.com"]);
    // The gateway moves: her token, given for the old URL, is not sent at all.
    await updateModelProvider(a.id, { baseUrl: "https://moved.example.com" }, admin);
    sent = [];
    await runCredentialPass({ now: NOW, force: true });
    expect(sent.some((s) => s.auth === "Bearer alice-for-a")).toBe(false);
    const [row] = await db
      .select()
      .from(credentialChecks)
      .where(eq(credentialChecks.credentialKey, `gateway:${a.id}:user:${alice.userId}`));
    expect(row).toMatchObject({
      status: "unknown",
      reason: "No token Optio may send to this gateway",
    });
  });

  it("warns by email once per threshold, and records the budget it read", async () => {
    const g = await litellm("Corp", "https://gw.example.com");
    await storePersonalGatewayToken(alice, "alice-key", g.id);
    keyInfo["alice-key"] = {
      spend: 9,
      max_budget: 10,
      expires: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
    };
    await runCredentialPass({ now: NOW, force: true });
    expect(subjects()).toEqual(["Your gateway token expires in 5 days"]);
    expect(mail.sent[0].to).toEqual([expect.stringMatching(/^alice\./)]);
    await runCredentialPass({ now: NOW, force: true });
    expect(subjects()).toHaveLength(1);
    const [view] = (await checkMine(alice.userId!, NOW)).filter((r) => r.kind === "gateway");
    expect(view).toMatchObject({ status: "warning" });
    expect(view.details).toMatchObject({ spend: 9, maxBudget: 10 });
    expect(JSON.stringify(view)).not.toContain("alice-key");

    // Over budget: an error, and its own warning.
    keyInfo["alice-key"] = { spend: 10.5, max_budget: 10, budget_reset_at: "2026-11-01T00:00:00Z" };
    await runCredentialPass({ now: NOW, force: true });
    expect(subjects()).toContain("Your gateway token is over budget");
  });

  it("shows each person their own rows, and a workspace's admins the organization's", async () => {
    const g = await litellm("Corp", "https://gw.example.com");
    await storePersonalGatewayToken(alice, "alice-key", g.id);
    await storePersonalGatewayToken(bob, "bob-key", g.id);
    await storeOrganizationGatewayToken(g.id, admin, "org-key");
    keyInfo["alice-key"] = keyInfo["bob-key"] = keyInfo["org-key"] = { spend: 0, max_budget: null };
    await runCredentialPass({ now: NOW, force: true });
    const viewer = (v: ProviderViewer, wsAdmin = false) => ({
      userId: v.userId,
      workspaceId: ws,
      isWorkspaceAdmin: wsAdmin,
      deploymentAdmin: false,
    });
    const keys = async (v: ReturnType<typeof viewer>) =>
      (await listChecks(v)).map((r) => r.credentialKey).sort();
    expect(await keys(viewer(alice))).toEqual([`gateway:${g.id}:user:${alice.userId}`]);
    expect(await keys(viewer(admin, true))).toEqual([`gateway:${g.id}:org`]);
  });

  it("sends GitLab tokens only to a host a deployment admin named", async () => {
    await storeSecret("GITLAB_TOKEN", "glpat-alice", "user", null, alice.userId);
    // Nothing named, and gateway-only: no host may be asked.
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    await runCredentialPass({ now: NOW, force: true });
    expect(sent.filter((s) => s.auth === "Bearer glpat-alice")).toEqual([]);
    const [row] = (await checkMine(alice.userId!, NOW)).filter((r) => r.kind === "gitlab");
    expect(row.status).toBe("unknown");

    vi.stubEnv("GITLAB_HOSTS", "gitlab.example.com");
    await db.delete(credentialChecks);
    sent = [];
    await runCredentialPass({ now: NOW, force: true });
    expect(sent.filter((s) => s.auth === "Bearer glpat-alice").map((s) => s.url)).toEqual([
      "https://gitlab.example.com/api/v4/personal_access_tokens/self",
    ]);
    // A host-specific token goes only to the host it names.
    await storeSecret("GITLAB_TOKEN_OTHER_EXAMPLE_COM", "glpat-other", "user", null, bob.userId);
    sent = [];
    await runCredentialPass({ now: NOW, force: true });
    expect(sent.filter((s) => s.auth === "Bearer glpat-other")).toEqual([]);
    // It expires in 7 days: warning, and an email to Alice.
    expect(subjects()).toContain("Your GitLab token expires in 7 days");
  });

  it("fails a run before its pod when the gateway already refuses the token", async () => {
    const g = await litellm("Corp", "https://gw.example.com");
    await storePersonalGatewayToken(alice, "alice-key", g.id);
    keyInfo["alice-key"] = { spend: 5.1, max_budget: 5, budget_reset_at: "2026-11-01T00:00:00Z" };
    const use = {
      agentType: "claude-code",
      agentOptions: { modelProvider: g.id },
      workspaceId: ws,
      ownerUserId: alice.userId,
      provider: await getModelProviderRow(g.id),
    };
    const err = await resolveGatewayRun(use).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayPreflightError);
    expect(err.message).toBe(
      "Your gateway token is over budget until 2026-11-01 00:00 UTC (5.10 of 5.00 USD spent): Settings → My tokens",
    );
    const row = (
      await listChecks({
        userId: alice.userId,
        workspaceId: ws,
        isWorkspaceAdmin: false,
        deploymentAdmin: false,
      })
    )[0];
    expect(row).toMatchObject({ status: "error", kind: "gateway" });

    // A healthy token, an unreachable gateway, or the switch off: the run goes on.
    keyInfo["alice-key"] = { spend: 1, max_budget: 5 };
    await expect(resolveGatewayRun(use)).resolves.toMatchObject({ token: "alice-key" });
    setGatewayFetchForTests(async (url) => {
      if (url.endsWith("/key/info")) throw new Error("ECONNREFUSED");
      return Response.json({ data: [] });
    });
    await expect(resolveGatewayRun(use)).resolves.toMatchObject({ token: "alice-key" });
    expect((await getModelProviderRow(g.id))?.id).toBe(g.id);
  });

  it("lets a run go on when the gateway only guards /key/info", async () => {
    const g = await litellm("Guarded", "https://guarded.example.com");
    await storePersonalGatewayToken(alice, "alice-key", g.id);
    for (const answer of [
      Response.json({ detail: "Forbidden" }, { status: 403 }),
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    ]) {
      setGatewayFetchForTests(async (url) =>
        url.endsWith("/key/info") ? answer.clone() : Response.json({ data: [{ id: "m" }] }),
      );
      await expect(
        resolveGatewayRun({
          agentType: "claude-code",
          agentOptions: { modelProvider: g.id },
          workspaceId: ws,
          ownerUserId: alice.userId,
          provider: await getModelProviderRow(g.id),
        }),
      ).resolves.toMatchObject({ token: "alice-key" });
    }
    expect(subjects().filter((s) => /rejected|refused/i.test(s))).toEqual([]);
  });
});
