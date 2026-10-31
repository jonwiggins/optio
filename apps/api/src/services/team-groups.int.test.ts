/**
 * Groups fill teams at sign-in (docs/teams.md) only from the provider and
 * authority a mapping names: the same bare group name from another
 * provider never grants a team role. Real Postgres.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs, teamMembers, users, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { qualifyGroups } from "./identity-groups.js";
import { completeSignIn, saveSignInConfig } from "./sign-in-config-service.js";
import { createTeam, setGroupMappings, TeamError } from "./team-service.js";
import { forgetSwitches } from "./deployment-settings.js";
import type { Actor } from "./ownership.js";

const uniq = () => randomBytes(4).toString("hex");
const oidc = { issuerUrl: "https://sso.example.com/realms/optio" };

async function person(name: string, provider = "oidc") {
  const [row] = await db
    .insert(users)
    .values({
      provider,
      externalId: uniq(),
      email: `${name}-${uniq()}@example.com`,
      emailVerified: true,
      displayName: name,
    })
    .returning();
  return row;
}

async function setup() {
  await saveSignInConfig("oidc", { clientId: "id", clientSecret: "s", settings: oidc }, null);
  const ws = await insertWorkspace();
  const [ann, cat, dan] = [
    await person("ann"),
    await person("cat"),
    await person("dan", "bitbucket"),
  ];
  await db.insert(workspaceMembers).values(
    [ann, cat, dan].map((u, i) => ({
      workspaceId: ws.id,
      userId: u.id,
      role: i === 0 ? ("admin" as const) : ("member" as const),
    })),
  );
  const admin: Actor = {
    userId: ann.id,
    workspaceId: ws.id,
    isAdmin: true,
    teamIds: [],
    adminTeamIds: [],
  };
  const team = await createTeam({ name: `SRE ${uniq()}` }, admin);
  const [sre] = qualifyGroups("oidc", oidc, ["sre"]);
  await setGroupMappings(team.id, [{ groupName: sre, role: "member" }], admin);
  return { ws, cat, dan, admin, team };
}

const membership = async (teamId: string, userId: string) =>
  (
    await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
  )[0];

describe("teams filled from sign-in groups", () => {
  beforeEach(async () => {
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "true");
    forgetSwitches();
    await db.delete(authProviderConfigs);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    forgetSwitches();
  });

  it("joins the mapped team from the named provider, and leaves when the group goes", async () => {
    const { cat, team } = await setup();
    await completeSignIn(cat, { provider: "oidc", groups: ["SRE"] });
    expect(await membership(team.id, cat.id)).toMatchObject({ source: "sso", status: "active" });
    // A sign-in without a groups claim says nothing: the membership stays.
    await completeSignIn(cat, { provider: "oidc" });
    expect(await membership(team.id, cat.id)).toBeDefined();
    await completeSignIn(cat, { provider: "oidc", groups: [] });
    expect(await membership(team.id, cat.id)).toBeUndefined();
  });

  it("never fills a team from an identically named group of another provider", async () => {
    const { dan, team } = await setup();
    // A Bitbucket workspace slug called "sre" is the user's to choose.
    await completeSignIn(dan, { provider: "bitbucket", groups: ["sre"] });
    expect(await membership(team.id, dan.id)).toBeUndefined();
  });

  it("refuses a mapping that names no provider", async () => {
    const { team, admin } = await setup();
    const err = await setGroupMappings(team.id, [{ groupName: "sre", role: "admin" }], {
      ...admin,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamError);
    expect((err as TeamError).status).toBe(400);
  });

  it("changes no team while teams are off", async () => {
    const { cat, team } = await setup();
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "false");
    forgetSwitches();
    await completeSignIn(cat, { provider: "oidc", groups: ["sre"] });
    expect(await membership(team.id, cat.id)).toBeUndefined();
  });
});
