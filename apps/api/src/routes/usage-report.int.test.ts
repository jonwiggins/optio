/**
 * The deployment usage report against real Postgres: usage recorded in two
 * workspaces (through the ledger triggers, as in production) comes back
 * totalled per workspace, person, repo, model, agent and month, only for a
 * deployment admin, and every CSV download is in the action log.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { optioActions, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { usageRoutes } from "./usage.js";

async function person(displayName: string, deploymentAdmin = false) {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomUUID(),
      email: `${randomUUID()}@test.invalid`,
      displayName,
      deploymentAdmin,
    })
    .returning();
  return u;
}

/** A run's usage, recorded by the ledger trigger and then dated `at`. */
async function run(
  at: string,
  fields: {
    workspaceId: string;
    ownerUserId?: string | null;
    repoUrl: string;
    modelUsed: string;
    agentType: string;
    costUsd: string;
    inputTokens: number;
    outputTokens: number;
  },
) {
  const task = await insertTask({ ...fields, state: "completed" });
  await db.execute(
    sql`UPDATE usage_ledger SET occurred_at = ${at}::timestamptz WHERE source_id = ${task.id}::uuid`,
  );
  return task;
}

type Row = {
  key: string | null;
  name: string;
  costUsd: string | null;
  tokens: number;
  runs: number;
};
const byName = (rows: Row[]) =>
  Object.fromEntries(
    rows.map((r) => [r.name, { cost: Number(r.costUsd), tokens: r.tokens, runs: r.runs }]),
  );

describe("deployment usage report (integration)", () => {
  let admin: Awaited<ReturnType<typeof person>>;
  let app: FastifyInstance;
  let wsA: string;
  let wsB: string;

  beforeAll(async () => {
    admin = await person("Report Admin", true);
    const ana = await person("Ana");
    const ben = await person("=Ben");
    wsA = (await insertWorkspace({ name: "Team A" })).id;
    wsB = (await insertWorkspace({ name: "Team B" })).id;
    const repo1 = "https://git.example.com/acme/one";
    const repo2 = "https://git.example.com/acme/two";
    const common = { inputTokens: 1000, outputTokens: 100 };
    await run("2026-01-10T12:00:00Z", {
      ...common,
      workspaceId: wsA,
      ownerUserId: ana.id,
      repoUrl: repo1,
      modelUsed: "model-x",
      agentType: "claude-code",
      costUsd: "1.25",
    });
    await run("2026-02-03T08:00:00Z", {
      ...common,
      workspaceId: wsA,
      ownerUserId: ben.id,
      repoUrl: repo2,
      modelUsed: "model-y",
      agentType: "codex",
      costUsd: "2",
    });
    await run("2026-02-20T23:30:00Z", {
      ...common,
      workspaceId: wsB,
      ownerUserId: ana.id,
      repoUrl: repo1,
      modelUsed: "model-x",
      agentType: "claude-code",
      costUsd: "0.5",
    });
    // Organization work (no owner) in workspace B.
    await run("2026-03-01T00:00:00Z", {
      ...common,
      workspaceId: wsB,
      ownerUserId: null,
      repoUrl: repo2,
      modelUsed: "model-x",
      agentType: "claude-code",
      costUsd: "4",
    });
    // Outside the range: the day after `to`.
    await run("2026-04-01T00:00:00Z", {
      ...common,
      workspaceId: wsA,
      ownerUserId: ana.id,
      repoUrl: repo1,
      modelUsed: "model-x",
      agentType: "claude-code",
      costUsd: "100",
    });
    app = await buildRouteTestApp(usageRoutes, {
      user: { id: admin.id, workspaceId: wsA, workspaceRole: "admin" },
    });
  });

  const report = async (groupBy: string, extra = "") => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/usage/report?from=2026-01-01&to=2026-03-31&groupBy=${groupBy}${extra}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { totals: { costUsd: string; runs: number; tokens: number }; rows: Row[] };
  };

  it("totals the whole range across workspaces", async () => {
    const r = await report("workspace");
    expect(Number(r.totals.costUsd)).toBe(7.75);
    expect(r.totals.runs).toBe(4);
    expect(r.totals.tokens).toBe(4400);
    expect(byName(r.rows)).toEqual({
      "Team A": { cost: 3.25, tokens: 2200, runs: 2 },
      "Team B": { cost: 4.5, tokens: 2200, runs: 2 },
    });
    expect(r.rows.find((x) => x.name === "Team A")?.key).toBe(wsA);
  });

  it("totals per person, with organization work on its own", async () => {
    expect(byName((await report("person")).rows)).toEqual({
      Ana: { cost: 1.75, tokens: 2200, runs: 2 },
      "=Ben": { cost: 2, tokens: 1100, runs: 1 },
      "Organization work": { cost: 4, tokens: 1100, runs: 1 },
    });
  });

  it("totals per repo, model and agent", async () => {
    expect(byName((await report("repo")).rows)).toEqual({
      "https://git.example.com/acme/one": { cost: 1.75, tokens: 2200, runs: 2 },
      "https://git.example.com/acme/two": { cost: 6, tokens: 2200, runs: 2 },
    });
    expect(byName((await report("model")).rows)).toEqual({
      "model-x": { cost: 5.75, tokens: 3300, runs: 3 },
      "model-y": { cost: 2, tokens: 1100, runs: 1 },
    });
    expect(byName((await report("agent")).rows)).toEqual({
      "claude-code": { cost: 5.75, tokens: 3300, runs: 3 },
      codex: { cost: 2, tokens: 1100, runs: 1 },
    });
  });

  it("totals per UTC month, in order", async () => {
    const r = await report("month");
    expect(r.rows.map((x) => [x.key, Number(x.costUsd)])).toEqual([
      ["2026-01", 1.25],
      ["2026-02", 2.5],
      ["2026-03", 4],
    ]);
  });

  it("narrows to one workspace on request", async () => {
    const r = await report("person", `&workspaceId=${wsB}`);
    expect(Number(r.totals.costUsd)).toBe(4.5);
    expect(byName(r.rows)).toEqual({
      Ana: { cost: 0.5, tokens: 1100, runs: 1 },
      "Organization work": { cost: 4, tokens: 1100, runs: 1 },
    });
  });

  it("refuses a workspace admin who is not a deployment admin", async () => {
    const other = await person("Workspace Admin");
    const theirs = await buildRouteTestApp(usageRoutes, {
      user: { id: other.id, workspaceId: wsB, workspaceRole: "admin" },
    });
    for (const path of ["report", "report.csv"]) {
      const res = await theirs.inject({ method: "GET", url: `/api/admin/usage/${path}` });
      expect(res.statusCode).toBe(403);
    }
    const logged = await db.select().from(optioActions).where(eq(optioActions.userId, other.id));
    expect(logged).toHaveLength(0);
  });

  it("exports CSV, neutralises formulas, and records the download", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/usage/report.csv?from=2026-01-01&to=2026-03-31&groupBy=person",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trimEnd().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.includes(",'=Ben,"))).toBe(true);
    expect(lines.some((l) => l.includes(",=Ben,"))).toBe(false);

    const logged = await db.select().from(optioActions).where(eq(optioActions.userId, admin.id));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      action: "usage.export",
      success: true,
      workspaceId: null,
      result: { from: "2026-01-01", to: "2026-03-31", groupBy: "person", count: 3 },
    });
  });
});
