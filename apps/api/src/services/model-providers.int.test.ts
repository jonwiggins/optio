/**
 * Model providers, work owners and picked pod secrets against a real
 * database: who may add / see / use a provider, what a pod run gets, and the
 * sign-in join by email domain.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, workspaceMembers, workspaces } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  createModelProvider,
  listModelProviders,
  podProviderRuntime,
  providerLaunch,
  resolveProviderForWork,
  updateModelProvider,
  ModelProviderError,
  type ProviderViewer,
} from "./model-provider-service.js";
import { listPickableSecrets, resolvePodSecrets, storeSecret } from "./secret-service.js";
import { ownerAfterUpdate, planNewWork, planWorkUpdate } from "./work-ownership.js";
import { joinWorkspacesByEmailDomain, normalizeAutoJoinDomains } from "./workspace-service.js";

async function insertUser(
  name: string,
  email = `${name}-${randomBytes(3).toString("hex")}@acme.dev`,
) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomBytes(6).toString("hex"),
      email,
      displayName: name,
    })
    .returning();
  return row;
}

describe("model providers", () => {
  let ws: string;
  let admin: ProviderViewer;
  let alice: ProviderViewer;
  let bob: ProviderViewer;

  beforeEach(async () => {
    ws = (await insertWorkspace()).id;
    const [a, b, c] = await Promise.all([
      insertUser("Ada"),
      insertUser("Alice"),
      insertUser("Bob"),
    ]);
    admin = { workspaceId: ws, userId: a.id, isAdmin: true };
    alice = { workspaceId: ws, userId: b.id, isAdmin: false };
    bob = { workspaceId: ws, userId: c.id, isAdmin: false };
  });

  const bedrock = (owner: "workspace" | "me", extra: Record<string, unknown> = {}) => ({
    name: owner === "me" ? "My Bedrock" : "Org Bedrock",
    owner,
    kind: "bedrock" as const,
    agents: ["claude-code" as const, "codex" as const],
    region: "us-west-2",
    ...extra,
  });

  it("lets admins add the organization's and anyone add their own", async () => {
    await expect(createModelProvider(bedrock("workspace"), alice)).rejects.toThrow(/Only admins/);
    const org = await createModelProvider(bedrock("workspace"), admin);
    const mine = await createModelProvider(bedrock("me"), alice);
    expect(org.ownerUserId).toBeNull();
    expect(mine.ownerUserId).toBe(alice.userId);
    expect(mine.mine).toBe(true);

    // Bob sees the org's only; the admin sees Alice's too, read-only.
    expect((await listModelProviders(bob)).map((p) => p.name)).toEqual(["Org Bedrock"]);
    const forAdmin = await listModelProviders(admin);
    expect(forAdmin.map((p) => [p.name, p.canEdit, p.ownerName])).toEqual([
      ["My Bedrock", false, "Alice"],
      ["Org Bedrock", true, null],
    ]);
    await expect(updateModelProvider(mine.id, { name: "x" }, admin)).rejects.toThrow(
      /Only its owner/,
    );
  });

  it("stores pod credentials encrypted, never returns them, and hands them to pods", async () => {
    const p = await createModelProvider(
      bedrock("workspace", {
        podCredential: "access-key",
        credentials: { type: "access-key", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cret" },
      }),
      admin,
    );
    expect(p.hasPodCredentials).toBe(true);
    expect(JSON.stringify(p)).not.toContain("s3cret");

    const row = await resolveProviderForWork({
      agentType: "claude-code",
      agentOptions: { modelProvider: p.id },
      workspaceId: ws,
      ownerUserId: null,
      runsOn: "pod",
    });
    expect(podProviderRuntime(row!, "claude-code").env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "s3cret",
    });
    expect(podProviderRuntime(row!, "codex").codexConfig).toEqual([
      'model_provider="amazon-bedrock"',
    ]);

    // Clearing the credentials makes it unusable in pods until replaced.
    await updateModelProvider(p.id, { credentials: null }, admin);
    await expect(
      resolveProviderForWork({
        agentType: "claude-code",
        agentOptions: { modelProvider: p.id },
        workspaceId: ws,
        ownerUserId: null,
        runsOn: "pod",
      }),
    ).rejects.toThrow(/no pod credentials/);
  });

  it("gives machines only the region and the AWS profile", async () => {
    const p = await createModelProvider(bedrock("me", { localAwsProfile: "bedrock" }), alice);
    const row = await resolveProviderForWork({
      agentType: "codex",
      agentOptions: { modelProvider: p.id },
      workspaceId: ws,
      ownerUserId: alice.userId,
      runsOn: "local",
    });
    expect(providerLaunch(row!)).toEqual({
      kind: "bedrock",
      providerId: p.id,
      name: "My Bedrock",
      region: "us-west-2",
      awsProfile: "bedrock",
    });
  });

  it("keeps a personal provider to its owner's work, and machines-only out of pods", async () => {
    const mine = await createModelProvider(bedrock("me"), alice);
    const use = (ownerUserId: string | null, runsOn: "pod" | "local", agentType = "claude-code") =>
      resolveProviderForWork({
        agentType,
        agentOptions: { modelProvider: mine.id },
        workspaceId: ws,
        ownerUserId,
        runsOn,
      });
    await expect(use(null, "local")).rejects.toThrow(/someone's own/);
    await expect(use(bob.userId, "local")).rejects.toThrow(/someone's own/);
    await expect(use(alice.userId, "pod")).rejects.toThrow(/machines only/);
    await expect(use(alice.userId, "local", "gemini")).rejects.toThrow(/isn't set up for gemini/);
    await expect(use(alice.userId, "local")).resolves.toMatchObject({ id: mine.id });
    await expect(
      resolveProviderForWork({
        agentType: "claude-code",
        agentOptions: { modelProvider: mine.id },
        workspaceId: (await insertWorkspace()).id,
        ownerUserId: alice.userId,
        runsOn: "local",
      }),
    ).rejects.toBeInstanceOf(ModelProviderError);
  });

  it("makes new work personal when it picks something personal, and checks org work", async () => {
    const mine = await createModelProvider(bedrock("me", { podCredential: "ambient" }), alice);
    const work = {
      agentType: "claude-code",
      agentOptions: { modelProvider: mine.id },
      runsOn: "pod" as const,
    };
    expect(await planNewWork({}, alice, work)).toEqual({
      ok: true,
      ownerUserId: alice.userId,
      podSecrets: undefined,
    });
    expect(await planNewWork({ owner: "workspace" }, alice, work)).toMatchObject({
      ok: false,
      status: 400,
    });
    // Bob can't change Alice's work, nor make org work his own unless he made it.
    const plan = await planWorkUpdate(
      { ownerUserId: alice.userId, agentOptions: work.agentOptions, podSecrets: null },
      { podSecrets: [] },
      bob,
      { agentType: "claude-code", runsOn: "pod", touchesRuntime: false },
    );
    expect(plan).toMatchObject({ ok: false, status: 403 });
    expect(() =>
      ownerAfterUpdate({ ownerUserId: null, createdBy: alice.userId }, "me", bob, "pod"),
    ).toThrow(/Only an admin/);
    expect(
      ownerAfterUpdate({ ownerUserId: null, createdBy: alice.userId }, "me", alice, "pod"),
    ).toBe(alice.userId);
  });

  it("offers org + own secrets and resolves the owner's first", async () => {
    await storeSecret("STRIPE_KEY", "org-value", "global", null);
    await storeSecret("NPM_TOKEN", "alice-npm", "user", null, alice.userId);
    await storeSecret("STRIPE_KEY", "alice-stripe", "user", null, alice.userId);
    await storeSecret("ANTHROPIC_API_KEY", "never-offered", "global", null);
    await storeSecret("CLAUDE_AUTH_MODE", "api-key", "global", null);

    const pickable = await listPickableSecrets(ws, alice.userId);
    expect(pickable).toContainEqual({ name: "STRIPE_KEY", owner: "workspace" });
    expect(pickable).toContainEqual({ name: "STRIPE_KEY", owner: "me" });
    expect(pickable).toContainEqual({ name: "NPM_TOKEN", owner: "me" });
    expect(pickable.map((s) => s.name)).not.toContain("ANTHROPIC_API_KEY");
    expect(pickable.map((s) => s.name)).not.toContain("CLAUDE_AUTH_MODE");

    // Org work: org secrets only, and it can't pick Alice's.
    expect(
      await resolvePodSecrets(["STRIPE_KEY", "NPM_TOKEN"], { workspaceId: ws, ownerUserId: null }),
    ).toEqual({ env: { STRIPE_KEY: "org-value" }, missing: ["NPM_TOKEN"] });
    expect(
      await planNewWork({ owner: "workspace", podSecrets: ["NPM_TOKEN"] }, alice, {
        agentType: "claude-code",
        agentOptions: null,
        runsOn: "pod",
      }),
    ).toMatchObject({ ok: false, status: 400 });
    // Alice's work: hers first.
    expect(
      await resolvePodSecrets(["STRIPE_KEY", "NPM_TOKEN", "ANTHROPIC_API_KEY"], {
        workspaceId: ws,
        ownerUserId: alice.userId,
      }),
    ).toEqual({ env: { STRIPE_KEY: "alice-stripe", NPM_TOKEN: "alice-npm" }, missing: [] });
  });
});

describe("sign-in by email domain", () => {
  it("refuses public mail domains and cleans the list", () => {
    expect(normalizeAutoJoinDomains(["@Acme.dev", "acme.dev", " eng.acme.dev "])).toEqual({
      domains: ["acme.dev", "eng.acme.dev"],
    });
    expect(normalizeAutoJoinDomains(["gmail.com"])).toHaveProperty("error");
    expect(normalizeAutoJoinDomains(["not a domain"])).toHaveProperty("error");
  });

  it("joins matching workspaces with a verified email only", async () => {
    const ws = await insertWorkspace({ autoJoinDomains: ["acme.dev"], autoJoinRole: "viewer" });
    await insertWorkspace({ autoJoinDomains: ["other.dev"] });
    const user = await insertUser("Newcomer", "new@acme.dev");

    expect(await joinWorkspacesByEmailDomain(user.id, user.email, false)).toEqual([]);
    expect(await joinWorkspacesByEmailDomain(user.id, user.email, true)).toEqual([ws.id]);
    // Again: already a member, nothing new.
    expect(await joinWorkspacesByEmailDomain(user.id, user.email, true)).toEqual([]);

    const [member] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id));
    expect(member).toMatchObject({ workspaceId: ws.id, role: "viewer" });
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u.defaultWorkspaceId).toBe(ws.id);
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(w.restrictPodSecrets).toBe(false);
  });
});
