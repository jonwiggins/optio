/**
 * The ticket round trip's settings routes (routes/ticket-round-trip.ts)
 * through the real auth plugin, real sessions and Postgres, with a fake Jira
 * Server and fakes of GitHub, GitLab, Linear and Notion: who may change a
 * provider's round trip (the same rule as changing the provider), the status
 * picker and the Test button.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { teamMembers, teams, ticketProviders, users, workspaceMembers } from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { getRedisClient } from "../services/event-bus.js";
import { storeSecret } from "../services/secret-service.js";
import { createSession } from "../services/session-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { startFakeJira, type FakeJira } from "../test-utils/fake-jira.js";
import { setOutboundDefaults, type FetchLike } from "@optio/shared/outbound-http";
import { fetchRoutedTo } from "../test-utils/fake-http.js";
import {
  GITHUB_API,
  startFakeGitHubIssues,
  type FakeGitHubIssues,
} from "../test-utils/fake-github-issues.js";
import {
  GITLAB_HOST,
  startFakeGitLabIssues,
  type FakeGitLabIssues,
} from "../test-utils/fake-gitlab-issues.js";
import { LINEAR_API, startFakeLinear, type FakeLinear } from "../test-utils/fake-linear.js";
import { NOTION_API, startFakeNotion, type FakeNotion } from "../test-utils/fake-notion.js";
import { ticketRoundTripRoutes } from "./ticket-round-trip.js";

// These tests run with teams on (off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
});

const uniq = () => randomBytes(4).toString("hex");

let app: FastifyInstance;
let jira: FakeJira;
let workspaceId: string;
let teamId: string;
const ids: Record<string, string> = {};
let restoreOutbound: (() => void) | undefined;

type Person = { userId: string; headers: Record<string, string> };
const people: Record<string, Person> = {};

async function signedIn(name: string, role: "admin" | "member" | "viewer"): Promise<Person> {
  const externalId = `rt-${name}-${uniq()}`;
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

async function provider(
  owner: { ownerUserId?: string | null; ownerTeamId?: string | null },
  over: { source?: string; config?: Record<string, unknown> } = {},
) {
  const [row] = await db
    .insert(ticketProviders)
    .values({
      source: over.source ?? "jira",
      config: over.config ?? {
        baseUrl: jira.url,
        deployment: "server",
        authType: "pat",
        projectKey: "PLAT",
      },
      workspaceId,
      ...owner,
    })
    .returning();
  await storeSecret(
    `ticket-provider:${row.id}`,
    JSON.stringify({ apiToken: "pat-1" }),
    "ticket-provider",
  );
  return row.id;
}

const SETTINGS = {
  enabled: true,
  comments: true,
  remoteLink: false,
  followUps: "mention",
  transitions: { started: "In Progress", mrOpened: "In Review", merged: "Done", failed: "" },
};

const save = (who: Person, id: string, body: unknown = SETTINGS) =>
  app.inject({
    method: "PUT",
    url: `/api/tickets/providers/${id}/round-trip`,
    headers: who.headers,
    payload: body as Record<string, unknown>,
  });

beforeAll(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
  jira = await startFakeJira({ pat: "pat-1" });
  jira.addIssue("PLAT-1", "To Do");

  workspaceId = (await insertWorkspace()).id;
  people.admin = await signedIn("admin", "admin");
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

  ids.org = await provider({});
  ids.team = await provider({ ownerUserId: people.lead.userId, ownerTeamId: teamId });
  ids.carol = await provider({ ownerUserId: people.carol.userId });
  ids.gitlab = await provider(
    {},
    { source: "gitlab", config: { host: "gitlab.example.test", projectPath: "p/r" } },
  );
  ids.noProject = await provider(
    {},
    { config: { baseUrl: jira.url, deployment: "server", authType: "pat" } },
  );

  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(ticketRoundTripRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await jira.close();
  vi.unstubAllEnvs();
  await getRedisClient().quit();
});

describe("who may change a provider's round trip", () => {
  it("the organization's: a workspace admin, not a member or a viewer", async () => {
    const res = await save(people.admin, ids.org);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().roundTrip).toEqual(SETTINGS);
    const [row] = await db.select().from(ticketProviders).where(eq(ticketProviders.id, ids.org));
    // Kept next to the rest of the config, which stays as it was.
    expect(row.config).toMatchObject({
      baseUrl: jira.url,
      projectKey: "PLAT",
      roundTrip: SETTINGS,
    });
    expect((await save(people.bob, ids.org)).statusCode).toBe(403);
    expect((await save(people.viewer, ids.org)).statusCode).toBe(403);
  });

  it("a team's: its team admins; a team member may not; others don't see it", async () => {
    expect((await save(people.lead, ids.team)).statusCode).toBe(200);
    expect((await save(people.bob, ids.team)).statusCode).toBe(403);
    expect((await save(people.carol, ids.team)).statusCode).toBe(404);
  });

  it("a person's: only that person (a workspace admin reads it, never changes it)", async () => {
    expect((await save(people.carol, ids.carol)).statusCode).toBe(200);
    expect((await save(people.admin, ids.carol)).statusCode).toBe(403);
    expect((await save(people.bob, ids.carol)).statusCode).toBe(404);
  });

  it("the deployment's (no workspace): a deployment admin, never just some workspace's admin", async () => {
    // Anyone may make a workspace and be its admin: that never reaches the deployment's providers.
    const root = await signedIn("root", "member");
    await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, root.userId));
    const [legacy] = await db
      .insert(ticketProviders)
      .values({ source: "jira", config: { baseUrl: jira.url, deployment: "server" } })
      .returning();
    expect((await save(people.admin, legacy.id)).statusCode).toBe(403);
    expect((await save(people.bob, legacy.id)).statusCode).toBe(403);
    expect((await save(root, legacy.id)).statusCode).toBe(200);
  });

  it("another workspace's provider is never found, whatever the caller's role there", async () => {
    const other = (await insertWorkspace()).id;
    const [elsewhere] = await db
      .insert(ticketProviders)
      .values({ source: "jira", config: { baseUrl: jira.url }, workspaceId: other })
      .returning();
    expect((await save(people.admin, elsewhere.id)).statusCode).toBe(404);
  });

  it("is for every source with a round trip, and takes only what it knows", async () => {
    expect((await save(people.admin, ids.gitlab)).statusCode).toBe(200);
    const bad = await save(people.admin, ids.org, { ...SETTINGS, followUps: "always" });
    expect(bad.statusCode).toBe(400);
  });

  it("keeps the sync's mark, and notes when follow-ups widen (older comments then don't count)", async () => {
    const id = await provider({});
    await db
      .update(ticketProviders)
      .set({
        config: {
          baseUrl: jira.url,
          deployment: "server",
          authType: "pat",
          roundTrip: { since: "2026-10-01T00:00:00.000Z" },
        },
      })
      .where(eq(ticketProviders.id, id));
    const read = async () =>
      ((await db.select().from(ticketProviders).where(eq(ticketProviders.id, id)))[0].config
        .roundTrip ?? {}) as Record<string, unknown>;

    // Default (Any) → Off → Mentions only → Any: the last two widen.
    expect((await save(people.admin, id, { ...SETTINGS, followUps: "off" })).statusCode).toBe(200);
    expect(await read()).toMatchObject({ since: "2026-10-01T00:00:00.000Z", followUps: "off" });
    expect((await read()).followUpsSince).toBeUndefined();

    const before = Date.now();
    const res = await save(people.admin, id, { ...SETTINGS, followUps: "mention" });
    expect(res.statusCode).toBe(200);
    // The reply is the settings only.
    expect(res.json().roundTrip).toEqual(SETTINGS);
    const widened = await read();
    expect(widened.since).toBe("2026-10-01T00:00:00.000Z");
    expect(Date.parse(widened.followUpsSince as string)).toBeGreaterThanOrEqual(before - 1000);

    // Narrowing, or saving the same mode, leaves the mark where it was.
    await save(people.admin, id, { ...SETTINGS, followUps: "mention", remoteLink: true });
    expect((await read()).followUpsSince).toBe(widened.followUpsSince);
  });
});

describe("the status picker and the Test button", () => {
  it("lists the project's statuses, or every status without a project", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tickets/providers/${ids.org}/round-trip/statuses`,
      headers: people.admin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      scope: "project",
      statuses: [
        { name: "To Do", category: "To Do" },
        { name: "In Progress", category: "In Progress" },
        { name: "In Review", category: "In Progress" },
        { name: "Done", category: "Done" },
      ],
    });
    const all = await app.inject({
      method: "GET",
      url: `/api/tickets/providers/${ids.noProject}/round-trip/statuses`,
      headers: people.admin.headers,
    });
    expect(all.json().scope).toBe("server");
    // Someone who may not change it doesn't get to use its credentials.
    const bob = await app.inject({
      method: "GET",
      url: `/api/tickets/providers/${ids.org}/round-trip/statuses`,
      headers: people.bob.headers,
    });
    expect(bob.statusCode).toBe(403);
  });

  it("checks the mapping on an issue without moving it", async () => {
    await save(people.admin, ids.org, {
      ...SETTINGS,
      transitions: { started: "In Progress", mrOpened: "To Do", merged: "Nowhere", failed: "" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/providers/${ids.org}/round-trip/check`,
      headers: people.admin.headers,
      payload: { issueKey: "plat-1" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      issueKey: "PLAT-1",
      status: "To Do",
      available: ["In Progress", "In Review", "Done"],
      steps: [
        { step: "started", status: "In Progress", outcome: "ready" },
        { step: "mrOpened", status: "To Do", outcome: "here" },
        { step: "merged", status: "Nowhere", outcome: "unreachable" },
      ],
    });
    expect(jira.issues.get("PLAT-1")!.status).toBe("To Do");
    expect(jira.callsTo("POST /rest/api/2/issue/PLAT-1/transitions")).toHaveLength(0);

    // The form's mapping, before it is saved.
    const unsaved = await app.inject({
      method: "POST",
      url: `/api/tickets/providers/${ids.org}/round-trip/check`,
      headers: people.admin.headers,
      payload: {
        issueKey: "PLAT-1",
        transitions: { started: "", mrOpened: "", merged: "Done", failed: "" },
      },
    });
    expect(unsaved.json().steps).toEqual([{ step: "merged", status: "Done", outcome: "ready" }]);
  });

  it("says why an issue can't be read, and refuses what isn't a key", async () => {
    const missing = await app.inject({
      method: "POST",
      url: `/api/tickets/providers/${ids.org}/round-trip/check`,
      headers: people.admin.headers,
      payload: { issueKey: "PLAT-404" },
    });
    expect(missing.json()).toMatchObject({ ok: false, issueKey: "PLAT-404" });
    expect(missing.json().error).toContain("404");
    const injection = await app.inject({
      method: "POST",
      url: `/api/tickets/providers/${ids.org}/round-trip/check`,
      headers: people.admin.headers,
      payload: { issueKey: "../../myself" },
    });
    expect(injection.statusCode).toBe(400);
  });
});

describe("every source's statuses and Test button", () => {
  let gh: FakeGitHubIssues;
  let gl: FakeGitLabIssues;
  let linear: FakeLinear;
  let notion: FakeNotion;
  const of: Record<string, string> = {};

  const other = async (source: string, config: Record<string, unknown>, secret: object) => {
    const [row] = await db
      .insert(ticketProviders)
      .values({ source, config, workspaceId })
      .returning();
    await storeSecret(`ticket-provider:${row.id}`, JSON.stringify(secret), "ticket-provider");
    return row.id;
  };
  const statuses = (id: string) =>
    app.inject({
      method: "GET",
      url: `/api/tickets/providers/${id}/round-trip/statuses`,
      headers: people.admin.headers,
    });
  const check = (id: string, issueKey: string, transitions: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: `/api/tickets/providers/${id}/round-trip/check`,
      headers: people.admin.headers,
      payload: {
        issueKey,
        transitions: { started: "", mrOpened: "", merged: "", failed: "", ...transitions },
      },
    });

  it("GitLab groups list group labels and test only tickets on their configured host", async () => {
    const id = await other(
      "gitlab",
      { host: GITLAB_HOST, groupPath: "acme" },
      { token: "glpat-1" },
    );
    const issue = gl.addIssue(90);
    const listed = await statuses(id);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      scope: "group",
      statuses: expect.arrayContaining([{ name: "workflow::doing", category: "Label" }]),
    });
    const result = await check(id, `https://${GITLAB_HOST}/acme/app/-/issues/90`, {
      started: "workflow::doing",
    });
    expect(result.json()).toMatchObject({
      ok: true,
      status: "Open",
      steps: [{ step: "started", status: "workflow::doing", outcome: "ready" }],
    });
    const before = gl.calls.length;
    const outside = await check(id, "https://evil.example/acme/app/-/issues/90", {});
    expect(outside.json()).toMatchObject({ ok: false });
    expect(gl.calls).toHaveLength(before);
    expect(issue.labels).toEqual(["optio"]);
  });

  beforeAll(async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", `127.0.0.1,${GITLAB_HOST}`);
    [gh, gl, linear, notion] = await Promise.all([
      startFakeGitHubIssues({ token: "ghp-1" }),
      startFakeGitLabIssues({ token: "glpat-1" }),
      startFakeLinear({ apiKey: "lin-1" }),
      startFakeNotion({ token: "secret-1" }),
    ]);
    const routed = fetchRoutedTo({
      [GITHUB_API]: gh.url,
      [`https://${GITLAB_HOST}`]: gl.url,
      [LINEAR_API]: linear.url,
      [NOTION_API]: notion.url,
    });
    vi.stubGlobal("fetch", routed);
    // A self-managed GitLab goes through the outbound guard: routed, its fake host on loopback.
    restoreOutbound = setOutboundDefaults({
      fetchImpl: routed as unknown as FetchLike,
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
      policy: { allowPrivate: false, allowAll: false, allowedHosts: ["127.0.0.1"] },
    });
    of.github = await other("github", { owner: "acme", repo: "app" }, { token: "ghp-1" });
    of.gitlab = await other(
      "gitlab",
      { host: GITLAB_HOST, projectPath: "acme/app" },
      { token: "glpat-1" },
    );
    of.linear = await other("linear", { teamId: linear.teamId }, { apiKey: "lin-1" });
    of.notion = await other("notion", { databaseId: notion.databaseId }, { apiKey: "secret-1" });
  });

  afterAll(async () => {
    restoreOutbound?.();
    vi.unstubAllGlobals();
    await Promise.all([gh, gl, linear, notion].map((f) => f?.close()));
  });

  it("GitHub: Open / Closed and the repository's labels; a label it has is here", async () => {
    const res = await statuses(of.github);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      scope: "repository",
      statuses: [
        { name: "Open", category: "State" },
        { name: "Closed", category: "State" },
        ...gh.labels.map((name) => ({ name, category: "Label" })),
      ],
    });
    gh.addIssue(21, "open", ["optio", "in progress"]);
    const tested = await check(of.github, "#21", {
      started: "in progress",
      mrOpened: "in review",
      merged: "Closed",
      failed: "wontfix",
    });
    expect(tested.json()).toEqual({
      ok: true,
      issueKey: "21",
      status: "Open",
      available: ["Closed", "bug", "in review"],
      steps: [
        { step: "started", status: "in progress", outcome: "here" },
        { step: "mrOpened", status: "in review", outcome: "ready" },
        { step: "merged", status: "Closed", outcome: "ready" },
        { step: "failed", status: "wontfix", outcome: "unreachable" },
      ],
    });
    // Nothing moved.
    expect(gh.issues.get(21)!.labels).toEqual(["optio", "in progress"]);
    expect(gh.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    // Not an issue number: refused before GitHub is asked.
    expect((await check(of.github, "PLAT-1", {})).statusCode).toBe(400);
  });

  it("GitLab: the project's labels; an issue it can't read says why", async () => {
    const res = await statuses(of.gitlab);
    expect(res.json().scope).toBe("project");
    expect(res.json().statuses.map((s: { name: string }) => s.name)).toEqual([
      "Open",
      "Closed",
      ...gl.labels,
    ]);
    gl.addIssue(31, "closed");
    expect((await check(of.gitlab, "31", { merged: "Closed" })).json().steps).toEqual([
      { step: "merged", status: "Closed", outcome: "here" },
    ]);
    const missing = await check(of.gitlab, "404", { merged: "Closed" });
    expect(missing.json()).toMatchObject({ ok: false, issueKey: "404" });
    expect(missing.json().error).toContain("GitLab answered 404");
  });

  it("Linear: the team's workflow states with their type; an identifier in any case", async () => {
    const res = await statuses(of.linear);
    expect(res.json()).toEqual({
      scope: "team",
      statuses: linear.states.map((s) => ({ name: s.name, category: s.type })),
    });
    linear.addIssue("ENG-41", "In Review");
    expect((await check(of.linear, "eng-41", { started: "In Progress" })).json()).toMatchObject({
      ok: true,
      issueKey: "ENG-41",
      status: "In Review",
      steps: [{ step: "started", status: "In Progress", outcome: "ready" }],
    });
  });

  it("Notion: the status property's options in their groups; a page link works", async () => {
    const res = await statuses(of.notion);
    expect(res.json()).toEqual({
      scope: "database",
      statuses: [
        { name: "Not started", category: "To-do" },
        { name: "In progress", category: "In progress" },
        { name: "In review", category: "In progress" },
        { name: "Done", category: "Complete" },
      ],
    });
    const page = notion.addPage("In progress");
    const link = `https://www.notion.so/acme/Add-health-${page.id.replace(/-/g, "")}`;
    expect(
      (await check(of.notion, link, { started: "In progress", merged: "Shipped" })).json(),
    ).toMatchObject({
      ok: true,
      issueKey: page.id,
      steps: [
        { step: "started", status: "In progress", outcome: "here" },
        { step: "merged", status: "Shipped", outcome: "unreachable" },
      ],
    });
  });

  it("saves any of them, switched on", async () => {
    for (const id of Object.values(of)) {
      const res = await save(people.admin, id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().roundTrip).toEqual(SETTINGS);
    }
    const off = await save(people.admin, of.github, { ...SETTINGS, enabled: false });
    expect(off.json().roundTrip.enabled).toBe(false);
  });
});
