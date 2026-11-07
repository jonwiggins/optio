/**
 * A team's work keeps its creator in `owner_user_id` but never runs with
 * their own rows (docs/teams.md): no private connection, MCP server or skill
 * of the creator's, even assigned to every repo or added by the work's own
 * settings, and the team's secret wins over the creator's for the same name.
 * Real Postgres.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { teams, users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildAgentEnvironment, environmentOptions } from "./agent-environment-service.js";
import { logger } from "../logger.js";
import { createConnection, seedBuiltInProviders } from "./connection-service.js";
import { createMcpServer } from "./mcp-server-service.js";
import { createSkill } from "./skill-service.js";
import { getGitToken } from "./git-token-service.js";
import { gitCredentialScope, parseGitCredentialScope } from "./git-credential-scope.js";
import {
  listPickableSecrets,
  podSecretsSelectionError,
  resolvePodSecrets,
  resolveSecretsForTask,
  storeSecret,
} from "./secret-service.js";

const uniq = () => randomBytes(4).toString("hex");

beforeAll(async () => {
  await seedBuiltInProviders();
});

async function world() {
  const ws = await insertWorkspace();
  const [alice] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${uniq()}`,
      email: `${uniq()}@example.com`,
      displayName: "Alice",
    })
    .returning();
  const [team, other] = await db
    .insert(teams)
    .values([
      { workspaceId: ws.id, name: `A ${uniq()}`, slug: `a-${uniq()}` },
      { workspaceId: ws.id, name: `B ${uniq()}`, slug: `b-${uniq()}` },
    ])
    .returning();
  // Alice's own rows, all of which would reach her personal work by default.
  const privateMcp = await createMcpServer(
    { name: "alice-mcp", command: "ALICE_PRIVATE_MCP", ownerUserId: alice.id },
    ws.id,
  );
  const privateSkill = await createSkill(
    { name: "alice-skill", prompt: "ALICE_PRIVATE_SKILL", ownerUserId: alice.id },
    ws.id,
  );
  const privateConnection = await createConnection(
    {
      name: "alice-files",
      providerSlug: "filesystem",
      config: { ROOT_PATH: "/home/alice-private" },
      ownerUserId: alice.id,
      assignments: [{ repoId: null }],
    },
    ws.id,
  );
  const orgMcp = await createMcpServer({ name: "docs", command: "ORG_MCP" }, ws.id);
  return { ws, alice, team, other, privateMcp, privateSkill, privateConnection, orgMcp };
}

type Env = Record<string, string>;
const filesOf = (env: Env): { path: string; content: string }[] =>
  env.OPTIO_SETUP_FILES
    ? JSON.parse(Buffer.from(env.OPTIO_SETUP_FILES, "base64").toString("utf8"))
    : [];

describe("a team's work", () => {
  it("gets the organization's MCP servers, skills and connections, never its creator's", async () => {
    const w = await world();
    const input = {
      repoUrl: null,
      agentType: "claude-code",
      workspaceId: w.ws.id,
      ownerUserId: w.alice.id,
      ownerTeamId: w.team.id,
      settings: {
        // Even asked for by id, the creator's rows stay out.
        mcpServers: { add: [w.privateMcp.id] },
        skills: { add: [w.privateSkill.id] },
        connections: { add: [w.privateConnection.id] },
      },
    };
    const env = await buildAgentEnvironment(input, logger);
    const rendered = JSON.stringify(filesOf(env));
    expect(rendered).toContain("ORG_MCP");
    expect(rendered).not.toMatch(/ALICE_PRIVATE|alice-private/);

    const offered = await environmentOptions(input);
    const ids = [...offered.mcpServers, ...offered.skills, ...offered.connections].map((r) => r.id);
    expect(ids).toContain(w.orgMcp.id);
    expect(ids).not.toContain(w.privateMcp.id);
    expect(ids).not.toContain(w.privateSkill.id);
    expect(ids).not.toContain(w.privateConnection.id);

    // The same creator's personal work does get them (the rule is upstream's).
    const personal = await buildAgentEnvironment({ ...input, ownerTeamId: null }, logger);
    expect(JSON.stringify(filesOf(personal))).toContain("ALICE_PRIVATE_MCP");
  });

  it("gets the team's secret, then the organization's, never its creator's own", async () => {
    const w = await world();
    const name = `TOKEN_${uniq().toUpperCase()}`;
    await storeSecret(name, "alice-private", "user", null, w.alice.id);
    await storeSecret(name, "org-value", "global");
    // Without a team secret: the organization's, not Alice's.
    expect((await resolveSecretsForTask([name], "", w.ws.id, w.alice.id, w.team.id))[name]).toBe(
      "org-value",
    );
    await storeSecret(name, "team-a-value", "team", w.ws.id, null, w.team.id);
    await storeSecret(name, "team-b-value", "team", w.ws.id, null, w.other.id);
    expect((await resolveSecretsForTask([name], "", w.ws.id, w.alice.id, w.team.id))[name]).toBe(
      "team-a-value",
    );
    expect(
      (
        await resolvePodSecrets([name], {
          workspaceId: w.ws.id,
          ownerUserId: w.alice.id,
          ownerTeamId: w.team.id,
        })
      ).env[name],
    ).toBe("team-a-value");
    // Personal work keeps upstream's order: the person's own first.
    expect((await resolveSecretsForTask([name], "", w.ws.id, w.alice.id))[name]).toBe(
      "alice-private",
    );
  });

  it("may pick only the organization's and its own team's secrets for its pod", async () => {
    const w = await world();
    const mine = `MINE_${uniq().toUpperCase()}`;
    const theirs = `THEIRS_${uniq().toUpperCase()}`;
    const ours = `OURS_${uniq().toUpperCase()}`;
    await storeSecret(mine, "x", "user", null, w.alice.id);
    await storeSecret(theirs, "x", "team", w.ws.id, null, w.other.id);
    await storeSecret(ours, "x", "team", w.ws.id, null, w.team.id);
    const opts = { workspaceId: w.ws.id, ownerUserId: w.alice.id, ownerTeamId: w.team.id };
    expect(await podSecretsSelectionError([ours], opts)).toBeNull();
    expect(await podSecretsSelectionError([mine], opts)).toMatch(/for this team/);
    expect(await podSecretsSelectionError([theirs], opts)).toMatch(/for this team/);
    const pickable = await listPickableSecrets(w.ws.id, w.alice.id, [w.team.id]);
    expect(pickable).toContainEqual({ name: ours, owner: `team:${w.team.id}` });
    expect(pickable.some((s) => s.name === theirs)).toBe(false);
  });

  it("reaches GitLab with the team's token, never its creator's own", async () => {
    const w = await world();
    const host = `git-${uniq()}.example.com`;
    await storeSecret("GITLAB_TOKEN", "alice-own-token", "user", null, w.alice.id);
    const team = { teamId: w.team.id, workspaceId: w.ws.id, host };
    // No team token: not Alice's (the organization's or the environment's).
    const before = await getGitToken("gitlab", { ...team, userId: w.alice.id }).catch(() => null);
    expect(before).not.toBe("alice-own-token");
    await storeSecret("GITLAB_TOKEN", "team-token", "team", w.ws.id, null, w.team.id);
    await expect(getGitToken("gitlab", { ...team, userId: w.alice.id })).resolves.toBe(
      "team-token",
    );
    // Personal work keeps the person's own token.
    await expect(
      getGitToken("gitlab", { userId: w.alice.id, workspaceId: w.ws.id, host }),
    ).resolves.toBe("alice-own-token");
    // A pod's credential scope names the team, and only for a team's work.
    const scoped = gitCredentialScope({
      workspaceId: w.ws.id,
      ownerUserId: w.alice.id,
      ownerTeamId: w.team.id,
      repoUrl: `https://${host}/acme/app`,
    });
    expect(parseGitCredentialScope(scoped)).toMatchObject({ ownerTeamId: w.team.id });
    const personal = gitCredentialScope({
      workspaceId: w.ws.id,
      ownerUserId: w.alice.id,
      repoUrl: null,
    });
    expect(parseGitCredentialScope(personal)).not.toHaveProperty("ownerTeamId");
  });
});
