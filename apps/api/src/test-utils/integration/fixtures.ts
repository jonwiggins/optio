/**
 * Row factories for integration tests (*.int.test.ts) — real INSERTs against
 * the per-file database, unlike ../fixtures.ts which provides in-memory
 * mock objects for unit tests.
 *
 * Every factory fills only the columns without schema defaults and returns
 * the full inserted row; pass overrides for anything a test cares about:
 *
 *     const task = await insertTask({ state: "queued", priority: 1 });
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  interactiveSessions,
  repos,
  sessionChatEvents,
  tasks,
  workDefinitions,
  workflowRuns,
  workflowTriggers,
  workspaces,
} from "../../db/schema.js";

const uniq = () => randomBytes(4).toString("hex");

type Insert<T extends { $inferInsert: unknown }> = Partial<T["$inferInsert"]>;

export async function insertWorkspace(overrides: Insert<typeof workspaces> = {}) {
  const [row] = await db
    .insert(workspaces)
    .values({ name: "it workspace", slug: `it-ws-${uniq()}`, ...overrides })
    .returning();
  return row;
}

export async function insertRepo(overrides: Insert<typeof repos> = {}) {
  const suffix = uniq();
  const [row] = await db
    .insert(repos)
    .values({
      repoUrl: `https://github.com/it-org/it-repo-${suffix}`,
      fullName: `it-org/it-repo-${suffix}`,
      ...overrides,
    })
    .returning();
  return row;
}

export async function insertTask(overrides: Insert<typeof tasks> = {}) {
  const [row] = await db
    .insert(tasks)
    .values({
      title: "it task",
      prompt: "integration test prompt",
      repoUrl: `https://github.com/it-org/it-repo-${uniq()}`,
      agentType: "claude-code",
      ...overrides,
    })
    .returning();
  return row;
}

type DefinitionInsert = Insert<typeof workDefinitions>;

/** A scheduled Task (`repo-blueprint` work definition); `title` is its run title, as in the API. */
export async function insertTaskConfig(overrides: DefinitionInsert & { title?: string } = {}) {
  const { title, ...rest } = overrides;
  const [row] = await db
    .insert(workDefinitions)
    .values({
      kind: "repo-blueprint",
      name: `it task config ${uniq()}`,
      runTitle: title ?? "it task config task",
      prompt: "integration test blueprint prompt",
      repoUrl: `https://github.com/it-org/it-repo-${uniq()}`,
      repoBranch: "main",
      maxRetries: 3,
      ...rest,
    })
    .returning();
  return row;
}

/** A Job (`standalone` work definition); `promptTemplate` is its prompt, as in the API. */
export async function insertWorkflow(
  overrides: DefinitionInsert & { promptTemplate?: string } = {},
) {
  const { promptTemplate, ...rest } = overrides;
  const [row] = await db
    .insert(workDefinitions)
    .values({
      kind: "standalone",
      name: `it workflow ${uniq()}`,
      prompt: promptTemplate ?? "integration test workflow prompt {{PARAM}}",
      agentType: "claude-code",
      localSessionMode: "headless",
      ...rest,
    })
    .returning();
  return row;
}

/**
 * A Local automation (`local-blueprint` work definition), with its API
 * names: `commandTemplate` is its prompt, `hostId` / `dir` its machine.
 */
export async function insertLocalBlueprint(
  overrides: DefinitionInsert & { commandTemplate?: string; hostId?: string; dir?: string } = {},
) {
  const { commandTemplate, hostId, dir, ...rest } = overrides;
  const [row] = await db
    .insert(workDefinitions)
    .values({
      kind: "local-blueprint",
      name: `it automation ${uniq()}`,
      prompt: commandTemplate ?? "echo integration",
      runTarget: "local",
      localHostId: hostId,
      localDir: dir,
      localSessionMode: "interactive",
      ...rest,
    })
    .returning();
  return row;
}

export async function insertWorkflowTrigger(
  targetId: string,
  overrides: Insert<typeof workflowTriggers> = {},
) {
  const [row] = await db
    .insert(workflowTriggers)
    .values({ targetId, type: "manual", ...overrides })
    .returning();
  return row;
}

/** A Job run; like `createWorkflowRun`, it takes its workspace and owner from its Job. */
export async function insertWorkflowRun(
  workflowId: string,
  overrides: Insert<typeof workflowRuns> = {},
) {
  const [job] = await db
    .select({
      workspaceId: workDefinitions.workspaceId,
      ownerUserId: workDefinitions.ownerUserId,
      runTarget: workDefinitions.runTarget,
      maxRetries: workDefinitions.maxRetries,
    })
    .from(workDefinitions)
    .where(eq(workDefinitions.id, workflowId));
  const [row] = await db
    .insert(workflowRuns)
    .values({ workflowId, ...job, ...overrides })
    .returning();
  return row;
}

/** A session with `n` chat events, one per millisecond: "event 1" … "event n". */
export async function insertSessionWithChatEvents(
  n: number,
  overrides: Insert<typeof interactiveSessions> = {},
) {
  const [session] = await db
    .insert(interactiveSessions)
    .values({
      repoUrl: `https://github.com/it-org/chat-${uniq()}`,
      branch: `session/it/${uniq()}`,
      ...overrides,
    })
    .returning();
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  for (let i = 0; i < n; i += 500) {
    await db.insert(sessionChatEvents).values(
      Array.from({ length: Math.min(500, n - i) }, (_, k) => ({
        sessionId: session.id,
        content: `event ${i + k + 1}`,
        logType: "text",
        timestamp: new Date(start + i + k),
      })),
    );
  }
  return session;
}
