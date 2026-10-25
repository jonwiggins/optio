/**
 * What a run tells GitLab about its work (work-traceability.ts), with the
 * people and teams in Postgres: the requester (the Jira reporter for ticket
 * work, else whoever made it), the team, the run's link, and the switches:
 * nothing unless OPTIO_WORK_TRACEABILITY=true, and OPTIO_COMMIT_TRAILERS=false
 * leaving the commit trailers out.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { teams, users } from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { localTraceabilityNote, workTraceability } from "./work-traceability.js";

const uniq = () => randomBytes(4).toString("hex");
let workspaceId: string;
let userId: string;
let teamId: string;

beforeAll(async () => {
  workspaceId = (await insertWorkspace()).id;
  const [u] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: `trace-${uniq()}`,
      email: "grace@example.test",
      displayName: "Grace Hopper",
    })
    .returning();
  userId = u.id;
  const [t] = await db
    .insert(teams)
    .values({ workspaceId, name: "Platform", slug: `platform-${uniq()}` })
    .returning();
  teamId = t.id;
});

beforeEach(() => vi.stubEnv("OPTIO_WORK_TRACEABILITY", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("off by default", () => {
  it("adds nothing to the prompt, the run's environment or a local run", async () => {
    vi.stubEnv("OPTIO_WORK_TRACEABILITY", "");
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    const task = await insertTask({
      title: "Fix",
      ticketSource: "jira",
      ticketExternalId: "PLAT-9",
      createdBy: userId,
      ownerTeamId: teamId,
      ownerUserId: userId,
      workspaceId,
    });
    expect(await workTraceability(task)).toEqual({ promptVars: {}, env: {} });
    expect(await localTraceabilityNote(task)).toBe("");
  });
});
afterAll(async () => {
  await getRedisClient().quit();
});

describe("what a run tells GitLab", () => {
  it("Jira work: the key, the reporter as co-author, the team, the run", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test/");
    const task = await insertTask({
      title: "Add a /health endpoint",
      ticketSource: "jira",
      ticketExternalId: "PLAT-1",
      metadata: {
        ticketUrl: "https://jira.example.test/browse/PLAT-1",
        ticketReporter: { name: "Ada Lovelace", email: "ada@example.test" },
      },
      createdBy: userId,
      ownerUserId: userId,
      ownerTeamId: teamId,
      workspaceId,
    });
    const { promptVars, env } = await workTraceability(task);
    expect(promptVars.MR_TITLE).toBe("PLAT-1: Add a /health endpoint");
    expect(promptVars.JIRA_KEY).toBe("PLAT-1");
    expect(promptVars.MR_FOOTER).toContain(
      "Jira: [PLAT-1](https://jira.example.test/browse/PLAT-1)",
    );
    expect(promptVars.MR_FOOTER).toContain("Requested by: Ada Lovelace");
    expect(promptVars.MR_FOOTER).toContain("Team: Platform");
    expect(env).toEqual({
      OPTIO_JIRA_KEY: "PLAT-1",
      OPTIO_COMMIT_CO_AUTHOR: "Ada Lovelace <ada@example.test>",
      OPTIO_RUN_URL: `https://optio.example.test/work/${task.id}`,
      OPTIO_TEAM_NAME: "Platform",
    });
  });

  it("a Jira that hides the reporter's email: named, no co-author (never the provider's owner)", async () => {
    const task = await insertTask({
      ticketSource: "jira",
      ticketExternalId: "PLAT-2",
      metadata: { ticketReporter: { name: "Ada Lovelace", email: null } },
      createdBy: userId,
      workspaceId,
    });
    const { promptVars, env } = await workTraceability(task);
    expect(promptVars.MR_FOOTER).toContain("Requested by: Ada Lovelace");
    expect(env.OPTIO_COMMIT_CO_AUTHOR).toBeUndefined();
    // No PUBLIC_URL: no run link rather than a wrong one.
    expect(env.OPTIO_RUN_URL).toBeUndefined();
  });

  it("other work: whoever made it", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    const task = await insertTask({ title: "Refactor", createdBy: userId, workspaceId });
    const { promptVars, env } = await workTraceability(task);
    expect(promptVars.MR_TITLE).toBe("Refactor");
    expect(promptVars.JIRA_KEY).toBe("");
    expect(env).toEqual({
      OPTIO_COMMIT_CO_AUTHOR: "Grace Hopper <grace@example.test>",
      OPTIO_RUN_URL: `https://optio.example.test/work/${task.id}`,
    });
  });

  it("OPTIO_COMMIT_TRAILERS=false: no trailers, the MR title and footer stay", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    vi.stubEnv("OPTIO_COMMIT_TRAILERS", "false");
    const task = await insertTask({
      title: "Fix",
      ticketSource: "jira",
      ticketExternalId: "PLAT-3",
      createdBy: userId,
      workspaceId,
    });
    const { promptVars, env } = await workTraceability(task);
    expect(env).toEqual({});
    expect(promptVars.COMMIT_TRAILERS).toBe("");
    expect(promptVars.MR_TITLE).toBe("PLAT-3: Fix");
    expect(promptVars.MR_FOOTER).toContain("Optio run:");
  });
});

describe("a run in a person's own checkout (no hook there)", () => {
  it("gets the title, the footer and the trailers as words, once", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
    const task = await insertTask({
      title: "Add a /health endpoint",
      ticketSource: "jira",
      ticketExternalId: "PLAT-4",
      metadata: { ticketReporter: { name: "Ada Lovelace", email: "ada@example.test" } },
      ownerTeamId: teamId,
      ownerUserId: userId,
      workspaceId,
    });
    const note = await localTraceabilityNote(task);
    expect(note).toContain('Title the merge request "PLAT-4: Add a /health endpoint".');
    expect(note).toContain("End the merge request's description with:");
    expect(note).toContain(
      `Jira: PLAT-4\nCo-authored-by: Ada Lovelace <ada@example.test>\nOptio-Run: https://optio.example.test/work/${task.id}\nOptio-Team: Platform`,
    );
  });

  it("is empty when there is nothing to say", async () => {
    const task = await insertTask({ title: "x", workspaceId });
    expect(await localTraceabilityNote(task)).toBe("");
  });
});
