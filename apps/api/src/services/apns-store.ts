/**
 * Persistence for APNs device tokens and ActivityKit tokens. The `ApnsStore`
 * interface is what apns-service depends on (tests inject an in-memory one);
 * `drizzleApnsStore` is the production implementation. Registration helpers
 * used by routes/notifications.ts live here too.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apnsDevices, liveActivityStartTokens, liveActivityTokens } from "../db/schema.js";
import type { ApnsEnvironment } from "./apns-transport.js";

export type LiveActivityKind = "watch";
export const LIVE_ACTIVITY_KINDS: readonly LiveActivityKind[] = ["watch"] as const;

export interface ApnsDeviceRow {
  id: string;
  userId: string;
  token: string;
  environment: ApnsEnvironment;
  bundleId: string;
  failureCount: number;
}

export interface LiveActivityTokenRow {
  id: string;
  userId: string;
  kind: LiveActivityKind;
  subjectId: string | null;
  token: string;
  environment: ApnsEnvironment;
  failureCount: number;
}

export interface LiveActivityStartTokenRow {
  id: string;
  userId: string;
  kind: LiveActivityKind;
  token: string;
  environment: ApnsEnvironment;
}

export interface ApnsStore {
  listDevices(userId: string): Promise<ApnsDeviceRow[]>;
  listLiveActivityTokens(userId: string, kind: LiveActivityKind): Promise<LiveActivityTokenRow[]>;
  listStartTokens(userId: string, kind: LiveActivityKind): Promise<LiveActivityStartTokenRow[]>;
  deleteDevice(id: string): Promise<void>;
  deleteLiveActivityToken(id: string): Promise<void>;
  deleteStartToken(id: string): Promise<void>;
  /** Success resets the counter (returns 0); failure increments and returns the new count. */
  recordDeviceResult(id: string, ok: boolean): Promise<number>;
  recordLiveActivityResult(id: string, ok: boolean): Promise<number>;
}

export const drizzleApnsStore: ApnsStore = {
  async listDevices(userId) {
    return db
      .select({
        id: apnsDevices.id,
        userId: apnsDevices.userId,
        token: apnsDevices.token,
        environment: apnsDevices.environment,
        bundleId: apnsDevices.bundleId,
        failureCount: apnsDevices.failureCount,
      })
      .from(apnsDevices)
      .where(eq(apnsDevices.userId, userId));
  },
  async listLiveActivityTokens(userId, kind) {
    return db
      .select({
        id: liveActivityTokens.id,
        userId: liveActivityTokens.userId,
        kind: liveActivityTokens.kind,
        subjectId: liveActivityTokens.subjectId,
        token: liveActivityTokens.token,
        environment: liveActivityTokens.environment,
        failureCount: liveActivityTokens.failureCount,
      })
      .from(liveActivityTokens)
      .where(and(eq(liveActivityTokens.userId, userId), eq(liveActivityTokens.kind, kind)));
  },
  async listStartTokens(userId, kind) {
    return db
      .select({
        id: liveActivityStartTokens.id,
        userId: liveActivityStartTokens.userId,
        kind: liveActivityStartTokens.kind,
        token: liveActivityStartTokens.token,
        environment: liveActivityStartTokens.environment,
      })
      .from(liveActivityStartTokens)
      .where(
        and(eq(liveActivityStartTokens.userId, userId), eq(liveActivityStartTokens.kind, kind)),
      );
  },
  async deleteDevice(id) {
    await db.delete(apnsDevices).where(eq(apnsDevices.id, id));
  },
  async deleteLiveActivityToken(id) {
    await db.delete(liveActivityTokens).where(eq(liveActivityTokens.id, id));
  },
  async deleteStartToken(id) {
    await db.delete(liveActivityStartTokens).where(eq(liveActivityStartTokens.id, id));
  },
  async recordDeviceResult(id, ok) {
    const [row] = await db
      .update(apnsDevices)
      .set(
        ok
          ? { failureCount: 0, lastSeenAt: new Date() }
          : { failureCount: sql`${apnsDevices.failureCount} + 1` },
      )
      .where(eq(apnsDevices.id, id))
      .returning({ failureCount: apnsDevices.failureCount });
    return row?.failureCount ?? 0;
  },
  async recordLiveActivityResult(id, ok) {
    const [row] = await db
      .update(liveActivityTokens)
      .set(
        ok
          ? { failureCount: 0, updatedAt: new Date() }
          : { failureCount: sql`${liveActivityTokens.failureCount} + 1` },
      )
      .where(eq(liveActivityTokens.id, id))
      .returning({ failureCount: liveActivityTokens.failureCount });
    return row?.failureCount ?? 0;
  },
};

// ── Registration (routes) ───────────────────────────────────────────────────

export interface RegisterDeviceInput {
  token: string;
  platform: "ios";
  environment: ApnsEnvironment;
  bundleId: string;
  appVersion?: string | null;
  deviceName?: string | null;
  workspaceId?: string | null;
}

/** Public shape of a device row — the token is masked. */
export interface ApnsDeviceView {
  id: string;
  token: string;
  platform: "ios";
  environment: ApnsEnvironment;
  bundleId: string;
  appVersion: string | null;
  deviceName: string | null;
  failureCount: number;
  lastSeenAt: Date;
  createdAt: Date;
}

export function maskToken(token: string): string {
  if (token.length <= 12) return "…";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function toView(row: typeof apnsDevices.$inferSelect): ApnsDeviceView {
  return {
    id: row.id,
    token: maskToken(row.token),
    platform: row.platform,
    environment: row.environment,
    bundleId: row.bundleId,
    appVersion: row.appVersion,
    deviceName: row.deviceName,
    failureCount: row.failureCount,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

/** Upsert by token; a token re-registered by another user moves to them. */
export async function registerDevice(
  userId: string,
  input: RegisterDeviceInput,
): Promise<ApnsDeviceView> {
  const [row] = await db
    .insert(apnsDevices)
    .values({
      userId,
      workspaceId: input.workspaceId ?? null,
      token: input.token,
      platform: input.platform,
      environment: input.environment,
      bundleId: input.bundleId,
      appVersion: input.appVersion ?? null,
      deviceName: input.deviceName ?? null,
    })
    .onConflictDoUpdate({
      target: apnsDevices.token,
      set: {
        userId,
        workspaceId: input.workspaceId ?? null,
        platform: input.platform,
        environment: input.environment,
        bundleId: input.bundleId,
        appVersion: input.appVersion ?? null,
        deviceName: input.deviceName ?? null,
        failureCount: 0,
        lastSeenAt: new Date(),
      },
    })
    .returning();
  return toView(row);
}

/** Delete the caller's device by raw token. Returns false when nothing matched. */
export async function unregisterDevice(userId: string, token: string): Promise<boolean> {
  const rows = await db
    .delete(apnsDevices)
    .where(and(eq(apnsDevices.userId, userId), eq(apnsDevices.token, token)))
    .returning({ id: apnsDevices.id });
  return rows.length > 0;
}

/** Delete the caller's device by row id (the device list only shows masked tokens). */
export async function unregisterDeviceById(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(apnsDevices)
    .where(and(eq(apnsDevices.userId, userId), eq(apnsDevices.id, id)))
    .returning({ id: apnsDevices.id });
  return rows.length > 0;
}

export async function listDevicesForUser(userId: string): Promise<ApnsDeviceView[]> {
  const rows = await db.select().from(apnsDevices).where(eq(apnsDevices.userId, userId));
  return rows.map(toView);
}

export interface RegisterLiveActivityTokenInput {
  kind: LiveActivityKind;
  token: string;
  environment: ApnsEnvironment;
  subjectId?: string | null;
}

/** Upsert an ActivityKit update token by token value. */
export async function registerLiveActivityToken(
  userId: string,
  input: RegisterLiveActivityTokenInput,
): Promise<void> {
  await db
    .insert(liveActivityTokens)
    .values({
      userId,
      kind: input.kind,
      subjectId: input.subjectId ?? null,
      token: input.token,
      environment: input.environment,
    })
    .onConflictDoUpdate({
      target: liveActivityTokens.token,
      set: {
        userId,
        kind: input.kind,
        subjectId: input.subjectId ?? null,
        environment: input.environment,
        failureCount: 0,
        updatedAt: new Date(),
      },
    });
}

export async function unregisterLiveActivityToken(
  userId: string,
  kind: LiveActivityKind,
  token: string,
): Promise<boolean> {
  const rows = await db
    .delete(liveActivityTokens)
    .where(
      and(
        eq(liveActivityTokens.userId, userId),
        eq(liveActivityTokens.kind, kind),
        eq(liveActivityTokens.token, token),
      ),
    )
    .returning({ id: liveActivityTokens.id });
  return rows.length > 0;
}

/** Upsert an ActivityKit push-to-start token by token value. */
export async function registerLiveActivityStartToken(
  userId: string,
  input: { kind: LiveActivityKind; token: string; environment: ApnsEnvironment },
): Promise<void> {
  await db
    .insert(liveActivityStartTokens)
    .values({ userId, kind: input.kind, token: input.token, environment: input.environment })
    .onConflictDoUpdate({
      target: liveActivityStartTokens.token,
      set: { userId, kind: input.kind, environment: input.environment, updatedAt: new Date() },
    });
}
