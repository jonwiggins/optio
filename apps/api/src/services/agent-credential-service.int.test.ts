/**
 * Agent credentials against a real database: what the Who section lists for
 * whom, which one is the default, who may store one, and what a run may use.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { secretCredentialId } from "@optio/shared";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  AgentCredentialError,
  createAgentCredential,
  listAgentCredentials,
  resolveCredentialForWork,
} from "./agent-credential-service.js";
import { createModelProvider } from "./model-provider-service.js";
import type { Actor } from "./ownership.js";
import { storeSecret } from "./secret-service.js";
import { workResourcesError } from "./work-ownership.js";

async function insertUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomBytes(6).toString("hex"),
      email: `${name}-${randomBytes(3).toString("hex")}@acme.dev`,
      displayName: name,
    })
    .returning();
  return row;
}

describe("agent credentials", () => {
  let ws: string;
  let admin: Actor;
  let alice: Actor;
  let bob: Actor;

  beforeEach(async () => {
    ws = (await insertWorkspace()).id;
    admin = { workspaceId: ws, userId: (await insertUser("Admin")).id, isAdmin: true };
    alice = { workspaceId: ws, userId: (await insertUser("Alice")).id, isAdmin: false };
    bob = { workspaceId: ws, userId: (await insertUser("Bob")).id, isAdmin: false };
  });

  it("lists the organization's and the viewer's own sign-ins in catalog order, default marked", async () => {
    await storeSecret("CLAUDE_AUTH_MODE", "oauth-token", "global");
    await storeSecret("ANTHROPIC_API_KEY", "org-key", "global");
    await storeSecret("CLAUDE_CODE_OAUTH_TOKEN", "org-token", "global");
    await storeSecret("ANTHROPIC_API_KEY", "alice-key", "user", undefined, alice.userId!);
    await storeSecret("GITHUB_TOKEN", "not-a-credential", "global");

    const forOrgWork = await listAgentCredentials(alice, "claude-code", "workspace");
    expect(forOrgWork.credentials.map((c) => [c.secretName, c.owner, c.default])).toEqual([
      ["CLAUDE_CODE_OAUTH_TOKEN", "workspace", true],
      ["ANTHROPIC_API_KEY", "workspace", false],
      ["ANTHROPIC_API_KEY", "me", false],
    ]);
    expect(forOrgWork.addable.map((a) => a.secretName)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
    expect(JSON.stringify(forOrgWork)).not.toContain("org-key");

    // Bob sees the organization's only.
    expect((await listAgentCredentials(bob, "claude-code", "me")).credentials).toHaveLength(2);

    // Alice's own mode makes her own key the default for her private work.
    await storeSecret("CLAUDE_AUTH_MODE", "api-key", "user", undefined, alice.userId!);
    const forHerWork = await listAgentCredentials(alice, "claude-code", "me");
    expect(forHerWork.credentials.find((c) => c.default)).toMatchObject({
      secretName: "ANTHROPIC_API_KEY",
      owner: "me",
    });
  });

  it("lists a model provider that serves the agent as a provider credential", async () => {
    const provider = await createModelProvider(
      {
        name: "Org Bedrock",
        owner: "workspace",
        kind: "bedrock",
        agents: ["claude-code"],
        region: "us-east-1",
        podCredential: "ambient",
      },
      admin,
    );
    const listed = await listAgentCredentials(alice, "claude-code", "workspace");
    expect(listed.credentials.find((c) => c.kind === "provider")).toMatchObject({
      id: `provider:${provider.id}`,
      providerId: provider.id,
      method: "bedrock",
      label: "Amazon Bedrock · Org Bedrock",
      owner: "workspace",
    });
    expect((await listAgentCredentials(alice, "codex", "workspace")).credentials).toEqual([]);
  });

  it("members store their own, only admins the organization's, and only known names", async () => {
    const mine = await createAgentCredential(alice, {
      agentType: "codex",
      secretName: "OPENAI_API_KEY",
      value: "sk-alice",
      owner: "me",
      verify: false,
    });
    expect(mine).toMatchObject({ kind: "secret", secretName: "OPENAI_API_KEY", owner: "me" });

    await expect(
      createAgentCredential(alice, {
        agentType: "codex",
        secretName: "OPENAI_API_KEY",
        value: "sk-org",
        owner: "workspace",
        verify: false,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const org = await createAgentCredential(admin, {
      agentType: "codex",
      secretName: "OPENAI_API_KEY",
      value: "sk-org",
      owner: "workspace",
      verify: false,
    });
    expect(org.owner).toBe("workspace");
    expect(org.id).not.toBe(mine.id);

    await expect(
      createAgentCredential(admin, {
        agentType: "codex",
        secretName: "GITHUB_TOKEN",
        value: "x",
        owner: "workspace",
      }),
    ).rejects.toThrow(/isn't a credential codex takes/);
    await expect(
      createAgentCredential(admin, {
        agentType: "codex",
        secretName: "CODEX_APP_SERVER_URL",
        value: "not a url",
        owner: "workspace",
      }),
    ).rejects.toThrow(/http\(s\) URL/);

    // Storing again replaces the value but keeps the row (and the id a work holds).
    const again = await createAgentCredential(alice, {
      agentType: "codex",
      secretName: "OPENAI_API_KEY",
      value: "sk-alice-2",
      owner: "me",
      verify: false,
    });
    expect(again.id).toBe(mine.id);
  });

  it("a run gets the picked value when the work's owner may use it, and nothing else", async () => {
    const mine = await createAgentCredential(alice, {
      agentType: "claude-code",
      secretName: "ANTHROPIC_API_KEY",
      value: "sk-alice",
      owner: "me",
      verify: false,
    });
    const pick = { credential: mine.id };
    const use = { agentType: "claude-code", workspaceId: ws, runsOn: "pod" as const };

    const picked = await resolveCredentialForWork({
      ...use,
      agentOptions: pick,
      ownerUserId: alice.userId,
    });
    expect(picked).toMatchObject({ secretName: "ANTHROPIC_API_KEY", value: "sk-alice" });

    await expect(
      resolveCredentialForWork({ ...use, agentOptions: pick, ownerUserId: null }),
    ).rejects.toThrow(AgentCredentialError);
    await expect(
      resolveCredentialForWork({ ...use, agentOptions: pick, ownerUserId: bob.userId }),
    ).rejects.toThrow(/own credential/);
    await expect(
      resolveCredentialForWork({
        ...use,
        agentOptions: { credential: secretCredentialId("33333333-3333-4333-8333-333333333333") },
        ownerUserId: alice.userId,
      }),
    ).rejects.toThrow(/removed/);

    // The same rule on save, through the work-ownership check.
    expect(
      await workResourcesError(
        { agentType: "claude-code", agentOptions: pick, runsOn: "pod", podSecrets: null },
        null,
        ws,
      ),
    ).toMatch(/own credential/);
    expect(
      await workResourcesError(
        { agentType: "claude-code", agentOptions: pick, runsOn: "pod", podSecrets: null },
        alice.userId,
        ws,
      ),
    ).toBeNull();
    expect(
      await workResourcesError(
        { agentType: "claude-code", agentOptions: pick, runsOn: "local", podSecrets: null },
        alice.userId,
        ws,
      ),
    ).toMatch(/machine/);
  });
});
