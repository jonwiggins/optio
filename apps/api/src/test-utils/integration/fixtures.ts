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
import { db } from "../../db/client.js";
import {
  repos,
  tasks,
  taskConfigs,
  workflowRuns,
  workflows,
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

export async function insertTaskConfig(overrides: Insert<typeof taskConfigs> = {}) {
  const [row] = await db
    .insert(taskConfigs)
    .values({
      name: `it task config ${uniq()}`,
      title: "it task config task",
      prompt: "integration test blueprint prompt",
      repoUrl: `https://github.com/it-org/it-repo-${uniq()}`,
      ...overrides,
    })
    .returning();
  return row;
}

export async function insertWorkflow(overrides: Insert<typeof workflows> = {}) {
  const [row] = await db
    .insert(workflows)
    .values({
      name: `it workflow ${uniq()}`,
      promptTemplate: "integration test workflow prompt {{PARAM}}",
      ...overrides,
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

export async function insertWorkflowRun(
  workflowId: string,
  overrides: Insert<typeof workflowRuns> = {},
) {
  const [row] = await db
    .insert(workflowRuns)
    .values({ workflowId, ...overrides })
    .returning();
  return row;
}
