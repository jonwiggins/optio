import { eq, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskMessages, tasks, users } from "../db/schema.js";
import { publishEvent } from "./event-bus.js";
import { getUserRole } from "./workspace-service.js";
import type { TaskMessageMode } from "@optio/shared";

export interface SendMessageInput {
  taskId: string;
  content: string;
  mode: TaskMessageMode;
  userId?: string;
  workspaceId?: string;
}

export async function sendMessage(input: SendMessageInput) {
  const [message] = await db
    .insert(taskMessages)
    .values({
      taskId: input.taskId,
      content: input.content,
      mode: input.mode,
      userId: input.userId,
      workspaceId: input.workspaceId,
    })
    .returning();

  // Update tasks.lastMessageAt
  await db
    .update(tasks)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(tasks.id, input.taskId));

  return message;
}

export async function listMessages(taskId: string) {
  const rows = await db
    .select({
      id: taskMessages.id,
      taskId: taskMessages.taskId,
      userId: taskMessages.userId,
      content: taskMessages.content,
      mode: taskMessages.mode,
      workspaceId: taskMessages.workspaceId,
      createdAt: taskMessages.createdAt,
      deliveredAt: taskMessages.deliveredAt,
      ackedAt: taskMessages.ackedAt,
      deliveryError: taskMessages.deliveryError,
      senderType: taskMessages.senderType,
      senderName: taskMessages.senderName,
      senderAddress: taskMessages.senderAddress,
      userName: users.displayName,
      userAvatar: users.avatarUrl,
    })
    .from(taskMessages)
    .leftJoin(users, eq(taskMessages.userId, users.id))
    .where(eq(taskMessages.taskId, taskId))
    .orderBy(taskMessages.createdAt);

  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    userId: row.userId,
    content: row.content,
    mode: row.mode,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    ackedAt: row.ackedAt,
    deliveryError: row.deliveryError,
    senderType: row.senderType,
    senderName: row.senderName,
    senderAddress: row.senderAddress,
    user: row.userId
      ? { id: row.userId, displayName: row.userName!, avatarUrl: row.userAvatar }
      : undefined,
  }));
}

export async function markDelivered(messageId: string) {
  await db
    .update(taskMessages)
    .set({ deliveredAt: new Date() })
    .where(eq(taskMessages.id, messageId));
}

export async function markAcked(messageId: string) {
  await db.update(taskMessages).set({ ackedAt: new Date() }).where(eq(taskMessages.id, messageId));
}

export async function markDeliveryError(messageId: string, error: string) {
  await db.update(taskMessages).set({ deliveryError: error }).where(eq(taskMessages.id, messageId));
}

/**
 * Check whether a user is allowed to send messages to a task.
 * The caller must be either the task creator or a workspace admin.
 */
export async function canMessageTask(
  userId: string,
  task: { createdBy?: string | null; workspaceId?: string | null },
): Promise<boolean> {
  // Task creator can always message
  if (task.createdBy && task.createdBy === userId) return true;

  // Workspace admin can message any task in the workspace (a deployment
  // admin too, when the deployment makes them admins of every workspace)
  if (task.workspaceId) {
    if ((await getUserRole(task.workspaceId, userId)) === "admin") return true;
  }

  return false;
}
