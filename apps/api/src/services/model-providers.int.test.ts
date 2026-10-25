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
import {
  GatewayTokenMissingError,
  defaultGateway,
  gatewayServesModel,
  resolveGatewayToken,
  setDefaultGateway,
  viewerGatewayStatus,
} from "./model-gateway-service.js";
import { teams, teamMembers } from "../db/schema.js";
import {
  deleteSecret,
  listPickableSecrets,
  resolvePodSecrets,
  storeSecret,
} from "./secret-service.js";
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

  const bedrock = (
    owner: "workspace" | "me" | `team:${string}`,
    extra: Record<string, unknown> = {},
  ) => ({
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

  it("refuses a team owner instead of storing the provider as someone else's", async () => {
    const team = "team:00000000-0000-4000-8000-000000000001" as const;
    await expect(createModelProvider(bedrock(team), admin)).rejects.toThrow(/not to a team/);
    await expect(createModelProvider(bedrock(team), alice)).rejects.toThrow(/not to a team/);
    const mine = await createModelProvider(bedrock("me"), alice);
    await expect(updateModelProvider(mine.id, { owner: team }, alice)).rejects.toThrow(
      /not to a team/,
    );
    expect((await listModelProviders(admin)).map((p) => p.name)).toEqual(["My Bedrock"]);
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
      ownerTeamId: null,
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

describe("model gateway (docs/model-gateway.md)", () => {
  let ws: string;
  let admin: ProviderViewer;
  let alice: ProviderViewer;

  beforeEach(async () => {
    ws = (await insertWorkspace()).id;
    const [a, b] = await Promise.all([insertUser("Ada"), insertUser("Alice")]);
    admin = { workspaceId: ws, userId: a.id, isAdmin: true };
    alice = { workspaceId: ws, userId: b.id, isAdmin: false };
  });

  const gateway = (extra: Record<string, unknown> = {}) => ({
    name: "Corp LiteLLM",
    owner: "workspace" as const,
    kind: "gateway" as const,
    agents: ["claude-code" as const, "opencode" as const],
    baseUrl: "https://litellm.example.com/",
    models: {
      "claude-code": [
        {
          id: "claude-sonnet-internal",
          label: "Sonnet (internal)",
          contextWindow: 200000,
          maxOutputTokens: 32000,
          efforts: ["low", "medium", "high"],
          defaultEffort: "high",
          prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          role: "sonnet" as const,
        },
        { id: "claude-haiku-internal", role: "haiku" as const },
      ],
      opencode: [{ id: "gpt-internal" }],
    },
    ...extra,
  });

  it("creates a gateway with its catalog, no region, and validates the URL", async () => {
    const p = await createModelProvider(gateway(), admin);
    expect(p).toMatchObject({
      kind: "gateway",
      region: "",
      baseUrl: "https://litellm.example.com",
      authHeader: "bearer",
      syncUrl: null,
      lastSyncedAt: null,
      tokenSource: "personal",
      podCredential: "none",
      hasPodCredentials: false,
    });
    expect(p.models["claude-code"]?.[0]).toEqual({
      id: "claude-sonnet-internal",
      label: "Sonnet (internal)",
      contextWindow: 200000,
      maxOutputTokens: 32000,
      efforts: ["low", "medium", "high"],
      defaultEffort: "high",
      prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      role: "sonnet",
    });
    expect(p.models.opencode).toEqual([{ id: "gpt-internal" }]);

    await expect(createModelProvider(gateway({ baseUrl: "litellm.corp" }), admin)).rejects.toThrow(
      /gateway URL/,
    );
    await expect(createModelProvider(gateway({ baseUrl: "" }), admin)).rejects.toThrow(
      /Give the gateway its URL/,
    );
    await expect(
      createModelProvider(
        gateway({
          models: { "claude-code": [{ id: "m", defaultEffort: "max", efforts: ["low"] }] },
        }),
        admin,
      ),
    ).rejects.toThrow(/default effort/);
    await expect(
      createModelProvider(
        gateway({ models: { "claude-code": [{ id: "m", role: "big" }] } }),
        admin,
      ),
    ).rejects.toThrow(/Unknown role/);
    await expect(
      createModelProvider(
        gateway({ models: { "claude-code": [{ id: "m", prices: { input: -1 } }] } }),
        admin,
      ),
    ).rejects.toThrow(/price/);
    await expect(createModelProvider(gateway({ tokenSource: "stored" }), admin)).rejects.toThrow(
      /shared token/,
    );
  });

  it("hands pods the gateway env with the owner's own token, and never someone else's", async () => {
    const p = await createModelProvider(gateway(), admin);
    const row = await resolveProviderForWork({
      agentType: "claude-code",
      agentOptions: {
        modelProvider: p.id,
        claudeModel: "claude-sonnet-internal",
        claudeEffort: "low",
      },
      workspaceId: ws,
      ownerUserId: alice.userId,
      runsOn: "pod",
    });
    expect(row).not.toBeNull();

    // No token yet: the run fails with the message that says where to add one.
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "org-token", "global", null);
    const missing = await resolveGatewayToken({
      provider: row!,
      workspaceId: ws,
      ownerUserId: alice.userId,
    }).catch((e) => e);
    expect(missing).toBeInstanceOf(GatewayTokenMissingError);
    expect(missing.message).toBe("Add your gateway token under Settings → My tokens");

    await storeSecret("ANTHROPIC_AUTH_TOKEN", "alice-token", "user", null, alice.userId);
    const token = await resolveGatewayToken({
      provider: row!,
      workspaceId: ws,
      ownerUserId: alice.userId,
    });
    expect(token).toBe("alice-token");
    expect(await resolveGatewayToken({ provider: row!, workspaceId: ws, ownerUserId: null })).toBe(
      "org-token",
    );

    const runtime = podProviderRuntime(
      row!,
      "claude-code",
      { model: "claude-sonnet-internal", effort: "low" },
      token,
    );
    expect(runtime.codexConfig).toEqual([]);
    expect(runtime.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://litellm.example.com",
      ANTHROPIC_AUTH_TOKEN: "alice-token",
      ANTHROPIC_MODEL: "claude-sonnet-internal",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-internal",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-internal",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-internal",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(podProviderRuntime(row!, "opencode", { model: "gpt-internal" }, token).env).toEqual({
      OPENAI_BASE_URL: "https://litellm.example.com/v1",
      OPENAI_API_KEY: "alice-token",
      OPTIO_OPENCODE_MODEL: "gpt-internal",
    });

    // A machine gets the same env, token included: it is Alice's token on Alice's machine.
    const launch = providerLaunch(row!, {
      agent: "claude-code",
      pick: { model: "claude-sonnet-internal" },
      token,
    });
    expect(launch).toMatchObject({
      kind: "gateway",
      providerId: p.id,
      baseUrl: "https://litellm.example.com",
      authHeader: "bearer",
    });
    expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe("alice-token");
  });

  it("checks the picked model against the catalog", async () => {
    const p = await createModelProvider(gateway(), admin);
    const use = (agentOptions: Record<string, unknown>, agentType = "claude-code") =>
      resolveProviderForWork({
        agentType,
        agentOptions: { modelProvider: p.id, ...agentOptions },
        workspaceId: ws,
        ownerUserId: alice.userId,
        runsOn: "pod",
      });
    await expect(use({ claudeModel: "claude-opus-4-8" })).rejects.toThrow(
      /doesn't serve the model/,
    );
    await expect(use({ claudeModel: "claude-haiku-internal" })).resolves.toMatchObject({
      id: p.id,
    });
    await expect(use({})).resolves.toMatchObject({ id: p.id });
    await expect(use({ opencodeModel: "other" }, "opencode")).rejects.toThrow(/doesn't serve/);
    await expect(use({}, "codex")).rejects.toThrow(/isn't set up for codex/);
    expect(await gatewayServesModel(ws, "claude-code", "claude-haiku-internal")).toBe(true);
    expect(await gatewayServesModel(ws, "claude-code", "claude-opus-4-8")).toBe(false);
  });

  it("stores one shared token when asked, and clears it going back to personal", async () => {
    const p = await createModelProvider(
      gateway({
        tokenSource: "stored",
        credentials: { type: "bearer-token", bearerToken: "shared" },
      }),
      admin,
    );
    expect(p).toMatchObject({
      tokenSource: "stored",
      podCredential: "bearer-token",
      hasPodCredentials: true,
    });
    expect(JSON.stringify(p)).not.toContain("shared");
    const row = await resolveProviderForWork({
      agentType: "claude-code",
      agentOptions: { modelProvider: p.id },
      workspaceId: ws,
      ownerUserId: alice.userId,
      runsOn: "pod",
    });
    expect(
      await resolveGatewayToken({ provider: row!, workspaceId: ws, ownerUserId: alice.userId }),
    ).toBe("shared");
    // The stored token is read from the row when the caller passes none.
    expect(podProviderRuntime(row!, "claude-code").env.ANTHROPIC_AUTH_TOKEN).toBe("shared");
    expect(podProviderRuntime(row!, "claude-code").env.ANTHROPIC_MODEL).toBe(
      "claude-sonnet-internal",
    );

    const back = await updateModelProvider(p.id, { tokenSource: "personal" }, admin);
    expect(back).toMatchObject({
      tokenSource: "personal",
      podCredential: "none",
      hasPodCredentials: false,
    });
    await expect(updateModelProvider(p.id, { tokenSource: "stored" }, admin)).rejects.toThrow(
      /Add the gateway's shared token/,
    );
    const changed = await updateModelProvider(
      p.id,
      {
        baseUrl: "https://other.example.com",
        authHeader: "api-key",
        syncUrl: "https://admin.example.com/",
      },
      admin,
    );
    expect(changed).toMatchObject({
      baseUrl: "https://other.example.com",
      authHeader: "api-key",
      syncUrl: "https://admin.example.com",
    });
    await expect(updateModelProvider(p.id, { baseUrl: "nope" }, admin)).rejects.toThrow(
      /gateway URL/,
    );
  });

  it("names the workspace's default gateway, falling back to the organization's first", async () => {
    expect(await defaultGateway(ws)).toBeNull();
    const first = await createModelProvider(gateway({ name: "First" }), admin);
    const second = await createModelProvider(gateway({ name: "Second" }), admin);
    expect((await defaultGateway(ws))?.id).toBe(first.id);
    await expect(setDefaultGateway(ws, second.id, alice)).rejects.toThrow(/Only admins/);
    await setDefaultGateway(ws, second.id, admin);
    expect((await defaultGateway(ws))?.id).toBe(second.id);
    const mine = await createModelProvider(gateway({ name: "Mine", owner: "me" }), alice);
    await expect(setDefaultGateway(ws, mine.id, admin)).rejects.toThrow(/organization's/);
    await setDefaultGateway(ws, null, admin);
    expect((await defaultGateway(ws))?.id).toBe(first.id);

    // Alice's standing: no token of her own yet; her team has one; the org
    // doesn't (global secrets outlive a test's workspace: clear the earlier one).
    await deleteSecret("ANTHROPIC_AUTH_TOKEN", "global").catch(() => {});
    const [team] = await db
      .insert(teams)
      .values({ workspaceId: ws, name: "Platform", slug: "platform" })
      .returning();
    await db.insert(teamMembers).values({ teamId: team.id, userId: alice.userId!, role: "member" });
    await storeSecret("ANTHROPIC_AUTH_TOKEN", "team-token", "team", ws, null, team.id);
    expect(await viewerGatewayStatus(alice, [team.id])).toEqual({
      gateway: {
        id: first.id,
        name: "First",
        baseUrl: "https://litellm.example.com",
        authHeader: "bearer",
        tokenSource: "personal",
        secretName: "ANTHROPIC_AUTH_TOKEN",
      },
      hasToken: false,
      keyInfo: null,
      teams: [{ id: team.id, name: "Platform", hasToken: true }],
      orgHasToken: false,
    });
    const row = await resolveProviderForWork({
      agentType: "claude-code",
      agentOptions: { modelProvider: first.id },
      workspaceId: ws,
      ownerUserId: alice.userId,
      runsOn: "pod",
    });
    expect(
      await resolveGatewayToken({
        provider: row!,
        workspaceId: ws,
        ownerUserId: alice.userId,
        ownerTeamId: team.id,
      }),
    ).toBe("team-token");
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
