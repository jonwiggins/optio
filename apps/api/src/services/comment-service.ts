import { eq, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskComments, users } from "../db/schema.js";
import { publishEvent } from "./event-bus.js";

export async function addComment(taskId: string, content: string, userId?: string) {
  const [comment] = await db.insert(taskComments).values({ taskId, content, userId }).returning();

  await publishEvent({
    type: "task:comment",
    taskId,
    commentId: comment.id,
    timestamp: new Date().toISOString(),
  });

  // Send push notification to task creator (fire-and-forget)
  import("./notification-service.js")
    .then(({ sendPushNotificationForComment }) => sendPushNotificationForComment(taskId, userId))
    .catch(() => {});

  return comment;
}

export async function listComments(taskId: string) {
  const rows = await db
    .select({
      id: taskComments.id,
      taskId: taskComments.taskId,
      userId: taskComments.userId,
      content: taskComments.content,
      createdAt: taskComments.createdAt,
      updatedAt: taskComments.updatedAt,
      userName: users.displayName,
      userAvatar: users.avatarUrl,
    })
    .from(taskComments)
    .leftJoin(users, eq(taskComments.userId, users.id))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(taskComments.createdAt);

  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    userId: row.userId,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    user: row.userId
      ? { id: row.userId, displayName: row.userName!, avatarUrl: row.userAvatar }
      : undefined,
  }));
}

export async function updateComment(commentId: string, content: string, userId?: string) {
  const [existing] = await db.select().from(taskComments).where(eq(taskComments.id, commentId));
  if (!existing) throw new Error("Comment not found");
  if (existing.userId && existing.userId !== userId) {
    throw new Error("Not authorized to edit this comment");
  }
  const [updated] = await db
    .update(taskComments)
    .set({ content, updatedAt: new Date() })
    .where(eq(taskComments.id, commentId))
    .returning();
  return updated;
}

export async function deleteComment(commentId: string, userId?: string) {
  const [existing] = await db.select().from(taskComments).where(eq(taskComments.id, commentId));
  if (!existing) throw new Error("Comment not found");
  if (existing.userId && existing.userId !== userId) {
    throw new Error("Not authorized to delete this comment");
  }
  await db.delete(taskComments).where(eq(taskComments.id, commentId));
}
