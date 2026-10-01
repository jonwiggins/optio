/**
 * Work definitions — saved, re-runnable work, one row each in
 * `work_definitions` (docs/plans/work-unification.md): a scheduled Task
 * (`repo-blueprint`), a Job (`standalone`), or a Local automation
 * (`local-blueprint`). This is the one CRUD over them. Their triggers (the
 * When) live in `workflow_triggers` under the kind's target type; firing one
 * goes through trigger-dispatch. The kinds' own services
 * (task-config-service, workflow-service, local-blueprint-service) project
 * rows back to the shapes their legacy endpoints always returned.
 */
import { and, desc, eq, inArray, type SQL, type SQLWrapper } from "drizzle-orm";
import type { TriggerTargetType, WorkDefinitionKind } from "@optio/shared";
import { db } from "../db/client.js";
import { workDefinitions, workflowTriggers, workRuns } from "../db/schema.js";

export type { WorkDefinitionKind };
export type WorkDefinition = typeof workDefinitions.$inferSelect;
export type WorkDefinitionValues = Omit<
  typeof workDefinitions.$inferInsert,
  "id" | "kind" | "createdAt" | "updatedAt"
>;

/** The pool, or a transaction — so a definition and its trigger can be written together. */
export type Db = Pick<typeof db, "select" | "insert" | "update" | "delete">;

/** The trigger target type each kind's triggers are filed under. */
export const TRIGGER_TARGET: Record<WorkDefinitionKind, TriggerTargetType> = {
  "repo-blueprint": "task_config",
  standalone: "job",
  "local-blueprint": "local_blueprint",
};

/** The definition kind a trigger target type names, or null for a non-definition target. */
export function definitionKindOf(targetType: string): WorkDefinitionKind | null {
  const found = Object.entries(TRIGGER_TARGET).find(([, t]) => t === targetType);
  return found ? (found[0] as WorkDefinitionKind) : null;
}

export async function createDefinition(
  kind: WorkDefinitionKind,
  values: WorkDefinitionValues,
  tx: Db = db,
): Promise<WorkDefinition> {
  const [row] = await tx
    .insert(workDefinitions)
    .values({ ...values, kind })
    .returning();
  return row;
}

/** A definition by id; with `kind`, only if it is one of those. */
export async function getDefinition(
  id: string,
  kind?: WorkDefinitionKind,
): Promise<WorkDefinition | null> {
  const [row] = await db
    .select()
    .from(workDefinitions)
    .where(and(eq(workDefinitions.id, id), kind ? eq(workDefinitions.kind, kind) : undefined));
  return row ?? null;
}

/** One kind's definitions, newest first, narrowed by `where` (a workspace, an owner). */
export async function listDefinitions(
  kind: WorkDefinitionKind,
  where?: SQL,
): Promise<WorkDefinition[]> {
  return db
    .select()
    .from(workDefinitions)
    .where(and(eq(workDefinitions.kind, kind), where))
    .orderBy(desc(workDefinitions.createdAt));
}

export async function updateDefinition(
  id: string,
  kind: WorkDefinitionKind,
  patch: Partial<WorkDefinitionValues>,
  tx: Db = db,
): Promise<WorkDefinition | null> {
  const [row] = await tx
    .update(workDefinitions)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(workDefinitions.id, id), eq(workDefinitions.kind, kind)))
    .returning();
  return row ?? null;
}

/** A Job's runs belong to it (tasks_standalone_check): they go before it does. */
async function deleteJobRuns(jobIds: string[] | SQLWrapper, tx: Db): Promise<void> {
  await tx
    .delete(workRuns)
    .where(and(eq(workRuns.kind, "standalone"), inArray(workRuns.workId, jobIds)));
}

/** Delete a definition and its triggers. A Job's runs go with it; tasks a scheduled Task spawned stay. */
export async function deleteDefinition(id: string, kind: WorkDefinitionKind): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (kind === "standalone") await deleteJobRuns([id], tx);
    await tx
      .delete(workflowTriggers)
      .where(
        and(
          eq(workflowTriggers.targetType, TRIGGER_TARGET[kind]),
          eq(workflowTriggers.targetId, id),
        ),
      );
    const deleted = await tx
      .delete(workDefinitions)
      .where(and(eq(workDefinitions.id, id), eq(workDefinitions.kind, kind)))
      .returning({ id: workDefinitions.id });
    return deleted.length > 0;
  });
}

/**
 * A workspace's scheduled Tasks and Jobs, their triggers, and the Jobs' runs
 * — for when the workspace is deleted. Local automations belong to a person, not the
 * workspace they were made in, so they stay.
 */
export async function deleteWorkspaceDefinitions(workspaceId: string, tx: Db): Promise<void> {
  const kinds: WorkDefinitionKind[] = ["repo-blueprint", "standalone"];
  const owned = and(
    eq(workDefinitions.workspaceId, workspaceId),
    inArray(workDefinitions.kind, kinds),
  );
  await deleteJobRuns(
    tx
      .select({ id: workDefinitions.id })
      .from(workDefinitions)
      .where(and(owned, eq(workDefinitions.kind, "standalone"))),
    tx,
  );
  await tx.delete(workflowTriggers).where(
    and(
      inArray(
        workflowTriggers.targetType,
        kinds.map((k) => TRIGGER_TARGET[k]),
      ),
      inArray(
        workflowTriggers.targetId,
        tx.select({ id: workDefinitions.id }).from(workDefinitions).where(owned),
      ),
    ),
  );
  await tx.delete(workDefinitions).where(owned);
}
