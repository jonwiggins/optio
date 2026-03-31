import { eq, desc, and, lte } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { schedules, scheduleRuns } from "../db/schema.js";

export interface CreateScheduleInput {
  name: string;
  description?: string;
  cronExpression: string;
  enabled?: boolean;
  taskConfig: {
    title: string;
    prompt: string;
    repoUrl: string;
    repoBranch?: string;
    agentType: string;
    maxRetries?: number;
    priority?: number;
  };
}

export interface UpdateScheduleInput {
  name?: string;
  description?: string;
  cronExpression?: string;
  enabled?: boolean;
  taskConfig?: CreateScheduleInput["taskConfig"];
}

function computeNextRun(cronExpression: string): Date {
  const interval = CronExpressionParser.parse(cronExpression);
  return interval.next().toDate();
}

export async function createSchedule(
  input: CreateScheduleInput,
  createdBy?: string,
  workspaceId?: string | null,
) {
  const nextRunAt = input.enabled !== false ? computeNextRun(input.cronExpression) : null;
  const [schedule] = await db
    .insert(schedules)
    .values({
      name: input.name,
      description: input.description ?? null,
      cronExpression: input.cronExpression,
      enabled: input.enabled ?? true,
      taskConfig: input.taskConfig,
      nextRunAt,
      createdBy: createdBy ?? null,
      workspaceId: workspaceId ?? null,
    })
    .returning();
  return schedule;
}

export async function listSchedules(workspaceId?: string | null) {
  if (workspaceId) {
    return db
      .select()
      .from(schedules)
      .where(eq(schedules.workspaceId, workspaceId))
      .orderBy(desc(schedules.createdAt));
  }
  return db.select().from(schedules).orderBy(desc(schedules.createdAt));
}

export async function getSchedule(id: string) {
  const [schedule] = await db.select().from(schedules).where(eq(schedules.id, id));
  return schedule ?? null;
}

export async function updateSchedule(id: string, input: UpdateScheduleInput) {
  const existing = await getSchedule(id);
  if (!existing) return null;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.taskConfig !== undefined) updates.taskConfig = input.taskConfig;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  // Recompute nextRunAt if cron or enabled changed
  const newCron = input.cronExpression ?? existing.cronExpression;
  const newEnabled = input.enabled ?? existing.enabled;
  if (input.cronExpression !== undefined) updates.cronExpression = input.cronExpression;
  if (newEnabled) {
    updates.nextRunAt = computeNextRun(newCron);
  } else {
    updates.nextRunAt = null;
  }

  const [updated] = await db.update(schedules).set(updates).where(eq(schedules.id, id)).returning();
  return updated;
}

export async function deleteSchedule(id: string) {
  const result = await db.delete(schedules).where(eq(schedules.id, id)).returning();
  return result.length > 0;
}

export async function recordRun(
  scheduleId: string,
  taskId: string | null,
  status: string,
  error?: string,
) {
  const [run] = await db
    .insert(scheduleRuns)
    .values({
      scheduleId,
      taskId,
      status,
      error: error ?? null,
    })
    .returning();
  return run;
}

export async function getScheduleRuns(scheduleId: string, limit = 50) {
  return db
    .select()
    .from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, scheduleId))
    .orderBy(desc(scheduleRuns.triggeredAt))
    .limit(limit);
}

export async function getDueSchedules() {
  const now = new Date();
  return db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)));
}

export async function markScheduleRan(id: string, cronExpression: string) {
  const now = new Date();
  const nextRunAt = computeNextRun(cronExpression);
  await db
    .update(schedules)
    .set({ lastRunAt: now, nextRunAt, updatedAt: now })
    .where(eq(schedules.id, id));
}

export function validateCronExpression(expression: string): {
  valid: boolean;
  error?: string;
  nextRun?: string;
  description?: string;
} {
  try {
    const interval = CronExpressionParser.parse(expression);
    const next = interval.next().toDate();
    return {
      valid: true,
      nextRun: next.toISOString(),
      description: describeCron(expression),
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Invalid cron expression",
    };
  }
}

function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return expression;
  const [min, hour, dom, mon, dow] = parts;

  if (min === "0" && hour === "0" && dom === "*" && mon === "*" && dow === "*")
    return "Every day at midnight";
  if (min === "0" && hour !== "*" && dom === "*" && mon === "*" && dow === "*")
    return `Every day at ${hour}:00`;
  if (dom === "*" && mon === "*" && dow === "*" && hour === "*" && min !== "*")
    return `Every hour at minute ${min}`;
  if (min === "0" && hour === "0" && dow === "1" && dom === "*" && mon === "*")
    return "Every Monday at midnight";
  if (min === "0" && hour === "0" && dom === "1" && mon === "*" && dow === "*")
    return "First of every month at midnight";
  if (min.startsWith("*/")) return `Every ${min.slice(2)} minutes`;
  if (hour.startsWith("*/")) return `Every ${hour.slice(2)} hours`;

  return expression;
}
