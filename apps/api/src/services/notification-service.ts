import { eq, and } from "drizzle-orm";
import webPush from "web-push";
import { db } from "../db/client.js";
import { pushSubscriptions, notificationPreferences, tasks } from "../db/schema.js";
import { logger } from "../logger.js";
import type { TaskState } from "@optio/shared";

// ── VAPID configuration ──────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY = process.env.OPTIO_VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE_KEY = process.env.OPTIO_VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.OPTIO_VAPID_SUBJECT ?? "";

let vapidConfigured = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  try {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidConfigured = true;
    logger.info("Web Push VAPID keys configured");
  } catch (err) {
    logger.warn({ err }, "Failed to configure VAPID keys — push notifications disabled");
  }
} else {
  logger.info("VAPID keys not set — push notifications disabled");
}

const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:3000";

/** Maximum consecutive failures before a subscription is removed. */
const MAX_FAILURE_COUNT = 5;

/** TTL for push messages (24 hours). */
const PUSH_TTL = 60 * 60 * 24;

// ── Notification event types & defaults ──────────────────────────────────────

export type NotificationEventType =
  | "task.pr_opened"
  | "task.completed"
  | "task.failed"
  | "task.needs_attention"
  | "task.stalled"
  | "task.review_requested"
  | "task.commented";

export const DEFAULT_PREFERENCES: Record<NotificationEventType, { push: boolean }> = {
  "task.pr_opened": { push: true },
  "task.completed": { push: true },
  "task.failed": { push: true },
  "task.needs_attention": { push: true },
  "task.stalled": { push: false },
  "task.review_requested": { push: false },
  "task.commented": { push: false },
};

/** Map task states to notification event types. */
const STATE_TO_EVENT: Partial<Record<TaskState, NotificationEventType>> = {
  pr_opened: "task.pr_opened",
  completed: "task.completed",
  failed: "task.failed",
  needs_attention: "task.needs_attention",
};

// ── Notification payload builders ────────────────────────────────────────────

interface NotificationPayload {
  title: string;
  body: string;
  icon: string;
  badge: string;
  tag: string;
  data: { url: string; eventType: string; taskId: string };
}

function buildPayload(
  eventType: NotificationEventType,
  task: { id: string; title: string; repoUrl: string; prUrl?: string | null },
): NotificationPayload {
  const repoName = task.repoUrl.replace(/^https?:\/\/[^/]+\//, "");
  const titles: Record<NotificationEventType, string> = {
    "task.pr_opened": "PR opened",
    "task.completed": "Task completed",
    "task.failed": "Task failed",
    "task.needs_attention": "Task needs attention",
    "task.stalled": "Task stalled",
    "task.review_requested": "Review requested",
    "task.commented": "New comment",
  };

  return {
    title: titles[eventType] ?? "Optio notification",
    body: `${task.title} — ${repoName}`,
    icon: "/icon.png",
    badge: "/badge.png",
    tag: `task-${task.id}`,
    data: {
      url: `${PUBLIC_URL}/tasks/${task.id}`,
      eventType,
      taskId: task.id,
    },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isVapidConfigured(): boolean {
  return vapidConfigured;
}

export function getVapidPublicKey(): string | null {
  return vapidConfigured ? VAPID_PUBLIC_KEY : null;
}

export async function subscribe(
  userId: string,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string,
): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
      set: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: userAgent ?? null,
        failureCount: 0,
        lastErrorAt: null,
      },
    });
}

export async function unsubscribe(userId: string, endpoint: string): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function listSubscriptions(userId: string) {
  return db
    .select({
      id: pushSubscriptions.id,
      userAgent: pushSubscriptions.userAgent,
      createdAt: pushSubscriptions.createdAt,
      lastUsedAt: pushSubscriptions.lastUsedAt,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
}

export async function getPreferences(userId: string): Promise<Record<string, { push: boolean }>> {
  const [row] = await db
    .select({ preferences: notificationPreferences.preferences })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  // Merge defaults with stored preferences
  const stored = (row?.preferences ?? {}) as Record<string, { push: boolean }>;
  const merged: Record<string, { push: boolean }> = {};
  for (const [key, def] of Object.entries(DEFAULT_PREFERENCES)) {
    merged[key] = stored[key] ?? def;
  }
  return merged;
}

export async function updatePreferences(
  userId: string,
  prefs: Record<string, { push: boolean }>,
): Promise<Record<string, { push: boolean }>> {
  // Merge with existing preferences
  const existing = await getPreferences(userId);
  const merged = { ...existing, ...prefs };

  await db
    .insert(notificationPreferences)
    .values({ userId, preferences: merged })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId],
      set: { preferences: merged, updatedAt: new Date() },
    });

  return merged;
}

export async function shouldNotify(
  userId: string,
  eventType: NotificationEventType,
): Promise<boolean> {
  const prefs = await getPreferences(userId);
  const pref = prefs[eventType];
  if (!pref) {
    // Unknown event type — use default if available
    const def = DEFAULT_PREFERENCES[eventType];
    return def?.push ?? false;
  }
  return pref.push;
}

/**
 * Send a push notification to all of a user's subscriptions.
 */
export async function sendPushToUser(
  userId: string,
  eventType: NotificationEventType,
  payload: NotificationPayload,
): Promise<void> {
  if (!vapidConfigured) return;

  const shouldSend = await shouldNotify(userId, eventType);
  if (!shouldSend) return;

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  if (subs.length === 0) return;

  const payloadStr = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payloadStr,
          { TTL: PUSH_TTL },
        );

        // Update lastUsedAt on success
        await db
          .update(pushSubscriptions)
          .set({ lastUsedAt: new Date(), failureCount: 0 })
          .where(eq(pushSubscriptions.id, sub.id));
      } catch (err: any) {
        const statusCode = err?.statusCode;

        if (statusCode === 404 || statusCode === 410) {
          // Subscription expired or invalid — remove it
          logger.info({ endpoint: sub.endpoint, userId }, "Removing expired push subscription");
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
          return;
        }

        // Increment failure count
        const newCount = sub.failureCount + 1;
        if (newCount >= MAX_FAILURE_COUNT) {
          logger.warn(
            { endpoint: sub.endpoint, userId, failureCount: newCount },
            "Removing push subscription after too many failures",
          );
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        } else {
          await db
            .update(pushSubscriptions)
            .set({ failureCount: newCount, lastErrorAt: new Date() })
            .where(eq(pushSubscriptions.id, sub.id));
        }

        logger.warn({ err, endpoint: sub.endpoint, userId }, "Push notification failed");
      }
    }),
  );
}

/**
 * Send a test notification to all of a user's subscriptions.
 */
export async function sendTestNotification(userId: string): Promise<number> {
  if (!vapidConfigured) return 0;

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  if (subs.length === 0) return 0;

  const payload = JSON.stringify({
    title: "Optio test notification",
    body: "If you see this, push notifications are working!",
    icon: "/icon.png",
    badge: "/badge.png",
    tag: "test",
    data: { url: `${PUBLIC_URL}/settings`, eventType: "test", taskId: "" },
  });

  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          { TTL: PUSH_TTL },
        );
        sent++;
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        }
        logger.warn({ err, endpoint: sub.endpoint }, "Test push notification failed");
      }
    }),
  );

  return sent;
}

/**
 * Fire-and-forget push notification for a task state transition.
 * Called from transitionTask().
 */
export async function sendPushNotificationForTransition(
  task: {
    id: string;
    title: string;
    repoUrl: string;
    prUrl?: string | null;
    createdBy?: string | null;
  },
  toState: TaskState,
): Promise<void> {
  if (!vapidConfigured) return;

  const eventType = STATE_TO_EVENT[toState];
  if (!eventType) return;

  // Only notify the task creator
  if (!task.createdBy) return;

  const payload = buildPayload(eventType, task);
  await sendPushToUser(task.createdBy, eventType, payload);
}

/**
 * Send a push notification for a task comment.
 * Notifies the task creator when someone else comments.
 */
export async function sendPushNotificationForComment(
  taskId: string,
  commenterId?: string,
): Promise<void> {
  if (!vapidConfigured) return;

  const [task] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      repoUrl: tasks.repoUrl,
      createdBy: tasks.createdBy,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  if (!task?.createdBy) return;
  // Don't notify the creator about their own comments
  if (commenterId && commenterId === task.createdBy) return;

  const payload = buildPayload("task.commented", task);
  await sendPushToUser(task.createdBy, "task.commented", payload);
}
