/**
 * The Work list against real tables: every kind lands in one list, scoped the
 * way each kind's own endpoint scopes it — workspace rows by workspace, a
 * person's machines and pod sessions by person.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  localHosts,
  localTerminals,
  persistentAgents,
  users,
} from "../db/schema.js";
import {
  insertLocalBlueprint,
  insertTask,
  insertTaskConfig,
  insertWorkflow,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { listWork, resolveWork } from "./work-service.js";

const uniq = () => randomBytes(4).toString("hex");

async function insertUser() {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: uniq(),
      email: `${uniq()}@example.com`,
      displayName: "Dev",
    })
    .returning();
  return row;
}

async function seedPerson(workspaceId: string, label: string) {
  const user = await insertUser();
  const [host] = await db
    .insert(localHosts)
    .values({
      userId: user.id,
      workspaceId,
      name: `${label}-mac`,
      hostname: uniq(),
      platform: "darwin",
    })
    .returning();
  const [terminal] = await db
    .insert(localTerminals)
    .values({
      hostId: host.id,
      userId: user.id,
      workspaceId,
      title: `${label} shell`,
      dir: "/Users/dev/app",
      spec: { kind: "shell" },
      state: "running",
      attentionState: "needs_you",
    })
    .returning();
  const blueprint = await insertLocalBlueprint({
    userId: user.id,
    workspaceId,
    name: `${label} automation`,
    hostId: host.id,
    commandTemplate: "claude",
  });
  const [session] = await db
    .insert(interactiveSessions)
    .values({ userId: user.id, workspaceId, repoUrl: "https://github.com/acme/app", branch: "s" })
    .returning();
  return { user, host, terminal, blueprint, session };
}

describe("listWork", () => {
  it("merges every kind and scopes workspace rows and personal rows separately", async () => {
    const ws = await insertWorkspace();
    const other = await insertWorkspace();
    const me = await seedPerson(ws.id, "me");
    const teammate = await seedPerson(ws.id, "teammate");

    const task = await insertTask({ workspaceId: ws.id, title: "Fix it", state: "running" });
    const config = await insertTaskConfig({ workspaceId: ws.id, name: "Nightly" });
    const job = await insertWorkflow({ workspaceId: ws.id, name: "Report" });
    const [agent] = await db
      .insert(persistentAgents)
      .values({ workspaceId: ws.id, slug: `forge-${uniq()}`, name: "Forge", initialPrompt: "hi" })
      .returning();
    const elsewhere = await insertTask({ workspaceId: other.id, title: "Not mine" });

    const rows = await listWork({ workspaceId: ws.id, userId: me.user.id });
    const keys = new Set(rows.map((r) => r.key));

    for (const key of [
      `task-${task.id}`,
      `blueprint-${config.id}`,
      `job-${job.id}`,
      `agent-${agent.id}`,
      `terminal-${me.terminal.id}`,
      `automation-${me.blueprint.id}`,
      `session-${me.session.id}`,
    ]) {
      expect(keys, key).toContain(key);
    }
    // A teammate's machines and pod sessions are theirs; another workspace's tasks are its own.
    expect(keys).not.toContain(`terminal-${teammate.terminal.id}`);
    expect(keys).not.toContain(`automation-${teammate.blueprint.id}`);
    expect(keys).not.toContain(`session-${teammate.session.id}`);
    expect(keys).not.toContain(`task-${elsewhere.id}`);

    // Needs-you first, and the caller's own machine is named.
    expect(rows[0]).toMatchObject({
      key: `terminal-${me.terminal.id}`,
      status: "needs_you",
      where: { target: "machine", detail: "me-mac · ~/app" },
    });
  });
});

describe("resolveWork", () => {
  it("resolves an id of any kind, and treats another scope's rows as missing", async () => {
    const ws = await insertWorkspace();
    const other = await insertWorkspace();
    const me = await seedPerson(ws.id, "me");
    const teammate = await seedPerson(ws.id, "teammate");
    const job = await insertWorkflow({ workspaceId: ws.id, name: "Report" });
    const foreign = await insertTask({ workspaceId: other.id });
    const scope = { workspaceId: ws.id, userId: me.user.id };

    expect(await resolveWork(job.id, scope)).toMatchObject({
      source: "standalone",
      row: { key: `job-${job.id}`, recurring: true },
      data: { id: job.id, name: "Report" },
    });
    expect((await resolveWork(me.blueprint.id, scope))?.source).toBe("local-blueprint");
    expect((await resolveWork(me.terminal.id, scope))?.source).toBe("local-terminal");
    expect((await resolveWork(me.session.id, scope))?.source).toBe("pod-session");

    expect(await resolveWork(foreign.id, scope)).toBeNull();
    expect(await resolveWork(teammate.terminal.id, scope)).toBeNull();
    expect(await resolveWork(teammate.blueprint.id, scope)).toBeNull();
    expect(await resolveWork("not-a-uuid", scope)).toBeNull();
  });
});
