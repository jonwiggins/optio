/**
 * Persistence for Android FCM registration tokens (`fcm_devices`). The
 * `FcmStore` interface is what fcm-service depends on (tests inject an
 * in-memory one); `drizzleFcmStore` is the production implementation.
 * Registration helpers used by routes/notifications.ts live here too.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { fcmDevices } from "../db/schema.js";

export interface FcmDeviceRow {
  id: string;
  userId: string;
  token: string;
  appId: string;
  /** The app's id for this server, echoed as `serverId` in every message. */
  clientServerId: string | null;
  failureCount: number;
}

export interface FcmStore {
  listDevices(userId: string): Promise<FcmDeviceRow[]>;
  deleteDevice(id: string): Promise<void>;
  /** Success resets the counter (returns 0); failure increments and returns the new count. */
  recordDeviceResult(id: string, ok: boolean): Promise<number>;
}

export const drizzleFcmStore: FcmStore = {
  async listDevices(userId) {
    return db
      .select({
        id: fcmDevices.id,
        userId: fcmDevices.userId,
        token: fcmDevices.token,
        appId: fcmDevices.appId,
        clientServerId: fcmDevices.clientServerId,
        failureCount: fcmDevices.failureCount,
      })
      .from(fcmDevices)
      .where(eq(fcmDevices.userId, userId));
  },
  async deleteDevice(id) {
    await db.delete(fcmDevices).where(eq(fcmDevices.id, id));
  },
  async recordDeviceResult(id, ok) {
    const [row] = await db
      .update(fcmDevices)
      .set(
        ok
          ? { failureCount: 0, lastSeenAt: new Date() }
          : { failureCount: sql`${fcmDevices.failureCount} + 1` },
      )
      .where(eq(fcmDevices.id, id))
      .returning({ failureCount: fcmDevices.failureCount });
    return row?.failureCount ?? 0;
  },
};

// ── Registration (routes) ───────────────────────────────────────────────────

export interface RegisterFcmDeviceInput {
  token: string;
  appId: string;
  appVersion?: string | null;
  deviceName?: string | null;
  /** The app's own id for this server (multi-server routing). */
  serverId?: string | null;
  workspaceId?: string | null;
}

/** Public shape of an Android device row — the token is masked. */
export interface FcmDeviceView {
  id: string;
  token: string;
  platform: "android";
  appId: string;
  serverId: string | null;
  appVersion: string | null;
  deviceName: string | null;
  failureCount: number;
  lastSeenAt: Date;
  createdAt: Date;
}

/** Same masking as the iOS rows (apns-store.ts `maskToken`): first 6 … last 4. */
function maskToken(token: string): string {
  if (token.length <= 12) return "…";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function toView(row: typeof fcmDevices.$inferSelect): FcmDeviceView {
  return {
    id: row.id,
    token: maskToken(row.token),
    platform: "android",
    appId: row.appId,
    serverId: row.clientServerId,
    appVersion: row.appVersion,
    deviceName: row.deviceName,
    failureCount: row.failureCount,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

/**
 * Upsert by token. Re-registering resets the failure counter; a token that
 * re-registers under another user moves to them (the phone changed hands or
 * re-paired with a different account).
 */
export async function registerFcmDevice(
  userId: string,
  input: RegisterFcmDeviceInput,
): Promise<FcmDeviceView> {
  const fields = {
    userId,
    workspaceId: input.workspaceId ?? null,
    appId: input.appId,
    appVersion: input.appVersion ?? null,
    deviceName: input.deviceName ?? null,
    clientServerId: input.serverId ?? null,
  };
  const [row] = await db
    .insert(fcmDevices)
    .values({ ...fields, token: input.token })
    .onConflictDoUpdate({
      target: fcmDevices.token,
      set: { ...fields, failureCount: 0, lastSeenAt: new Date() },
    })
    .returning();
  return toView(row);
}

/** Delete the caller's device by raw token. Returns false when nothing matched. */
export async function unregisterFcmDevice(userId: string, token: string): Promise<boolean> {
  const rows = await db
    .delete(fcmDevices)
    .where(and(eq(fcmDevices.userId, userId), eq(fcmDevices.token, token)))
    .returning({ id: fcmDevices.id });
  return rows.length > 0;
}

/** Delete the caller's device by row id (what the masked device list offers). */
export async function unregisterFcmDeviceById(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(fcmDevices)
    .where(and(eq(fcmDevices.userId, userId), eq(fcmDevices.id, id)))
    .returning({ id: fcmDevices.id });
  return rows.length > 0;
}

export async function listFcmDevicesForUser(userId: string): Promise<FcmDeviceView[]> {
  const rows = await db
    .select()
    .from(fcmDevices)
    .where(eq(fcmDevices.userId, userId))
    .orderBy(fcmDevices.createdAt);
  return rows.map(toView);
}
