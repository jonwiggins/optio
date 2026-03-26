import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskTemplates } from "../db/schema.js";

export async function listTaskTemplates(repoUrl?: string) {
  if (repoUrl) {
    return db.select().from(taskTemplates).where(eq(taskTemplates.repoUrl, repoUrl));
  }
  return db.select().from(taskTemplates);
}

export async function getTaskTemplate(id: string) {
  const [template] = await db.select().from(taskTemplates).where(eq(taskTemplates.id, id));
  return template ?? null;
}

export async function createTaskTemplate(data: {
  name: string;
  repoUrl?: string;
  prompt: string;
  agentType?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}) {
  const [template] = await db
    .insert(taskTemplates)
    .values({
      name: data.name,
      repoUrl: data.repoUrl ?? null,
      prompt: data.prompt,
      agentType: data.agentType ?? "claude-code",
      priority: data.priority ?? 100,
      metadata: data.metadata,
    })
    .returning();
  return template;
}

export async function updateTaskTemplate(
  id: string,
  data: {
    name?: string;
    repoUrl?: string | null;
    prompt?: string;
    agentType?: string;
    priority?: number;
    metadata?: Record<string, unknown>;
  },
) {
  const [template] = await db
    .update(taskTemplates)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(taskTemplates.id, id))
    .returning();
  return template ?? null;
}

export async function deleteTaskTemplate(id: string) {
  await db.delete(taskTemplates).where(eq(taskTemplates.id, id));
}
