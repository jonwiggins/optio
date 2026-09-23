/**
 * FCM delivery for the Android app — the twin of apns-service.ts: alert
 * fan-out to a user's devices, and the "Watch" (the iOS Live Activity) as data
 * messages that drive the app's ongoing notification (docs/android-push.md).
 *
 * Configuration (a Firebase service-account key; no SDK):
 *   OPTIO_FCM_SERVICE_ACCOUNT (the key JSON, or base64 of it) or
 *   OPTIO_FCM_SERVICE_ACCOUNT_FILE, OPTIO_FCM_PROJECT_ID (default: the key's
 *   project_id), OPTIO_FCM_TRANSPORT=fake (tests/e2e: record instead of send;
 *   OPTIO_FCM_FAKE_OUTBOX=<file> also appends each request as JSONL).
 * Unset → `isConfigured()` is false and every method is a no-op, exactly like
 * APNs and VAPID.
 *
 * Delivery discipline (mirrors apns_devices):
 *   - Watch frames per device go through the same coalescer as the Live
 *     Activity (≤1 push / s / device, trailing edge, identical frames dropped)
 *   - UNREGISTERED / 404 / SENDER_ID_MISMATCH / INVALID_ARGUMENT on the token
 *     → delete the row immediately
 *   - 5 consecutive failures → delete; success resets the counter
 *   - our own credential failures (token exchange, 401, 403) are logged and
 *     never counted against a device
 *
 * Android has no per-activity push tokens, so every Watch frame goes to all of
 * the user's devices and the app decides what to show. The server tracks, per
 * user, whether it has started a Watch: the first active frame is `start`,
 * later ones `update`, and the frame after the quiet grace period `end`.
 *
 * Preference checks (notification-service.shouldNotify) are the caller's job —
 * glance-service.ts routes every alert through them via push-fanout.ts.
 */
import { readFileSync } from "node:fs";
import type { WatchState } from "@optio/shared";
import { logger } from "../logger.js";
import { watchStateHash, type AlertInput } from "./apns-payloads.js";
import { parseServiceAccount, ServiceAccountError, type GoogleServiceAccount } from "./fcm-auth.js";
import { buildFcmAlertMessage, buildFcmWatchMessage } from "./fcm-payloads.js";
import { drizzleFcmStore, type FcmDeviceRow, type FcmStore } from "./fcm-store.js";
import {
  FakeFcmTransport,
  FcmHttpTransport,
  isUnregisteredFcmResult,
  type FcmSendResult,
  type FcmTransport,
} from "./fcm-transport.js";
import { WATCH_COALESCE_MS, WatchCoalescer, type WatchFrameEvent } from "./watch-coalescer.js";

/** Maximum consecutive failures before a device row is removed (same as APNs). */
export const FCM_MAX_FAILURE_COUNT = 5;

/** Log a credential/config failure at most this often (it hits every send). */
const SERVER_FAILURE_LOG_INTERVAL_MS = 60_000;

export interface FcmConfig {
  projectId: string;
  serviceAccount: GoogleServiceAccount;
}

export function readFcmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FcmConfig | null {
  let raw = env.OPTIO_FCM_SERVICE_ACCOUNT?.trim() ?? "";
  if (!raw && env.OPTIO_FCM_SERVICE_ACCOUNT_FILE) {
    try {
      raw = readFileSync(env.OPTIO_FCM_SERVICE_ACCOUNT_FILE, "utf8");
    } catch (err) {
      logger.warn(
        { err, file: env.OPTIO_FCM_SERVICE_ACCOUNT_FILE },
        "FCM: could not read service account file",
      );
    }
  }
  if (!raw.trim()) return null;
  let serviceAccount: GoogleServiceAccount;
  try {
    serviceAccount = parseServiceAccount(raw);
  } catch (err) {
    const reason = err instanceof ServiceAccountError ? err.message : "unreadable";
    logger.warn({ reason }, "FCM: invalid service account key");
    return null;
  }
  const projectId = env.OPTIO_FCM_PROJECT_ID?.trim() || serviceAccount.projectId;
  if (!projectId) {
    logger.warn("FCM: no project id — set OPTIO_FCM_PROJECT_ID or use a key with project_id");
    return null;
  }
  return { projectId, serviceAccount };
}

/** One Android device, as the Watch coalescer's delivery target. */
interface DeviceTarget {
  token: string;
  userId: string;
  serverId: string | null;
}

export interface FcmServiceOptions {
  transport: FcmTransport | null;
  store: FcmStore;
  coalesceMs?: number;
  now?: () => Date;
}

export class FcmService {
  private readonly transport: FcmTransport | null;
  private readonly store: FcmStore;
  private readonly now: () => Date;
  /** Per-device coalescing + dedupe of Watch frames (keyed by device row id). */
  private readonly frames: WatchCoalescer<DeviceTarget, true, FcmSendResult>;
  /** userId → whether the server started a Watch on the user's devices. Absent = unknown (e.g. after a restart). */
  private watch = new Map<string, "live" | "ended">();
  private lastServerFailureLog = 0;

  constructor(opts: FcmServiceOptions) {
    this.transport = opts.transport;
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
    this.frames = new WatchCoalescer({
      coalesceMs: opts.coalesceMs ?? WATCH_COALESCE_MS,
      send: (t, frame) =>
        this.transport!.send({
          ...buildFcmWatchMessage({
            event: frame.event,
            state: frame.state,
            alert: !!frame.alert,
            serverId: t.serverId,
          }),
          token: t.token,
        }),
      settle: (deviceId, t, result) => this.settleDevice(deviceId, t.token, t.userId, result),
      onFlushError: (err, t) =>
        logger.warn({ err, userId: t.userId }, "FCM: coalesced Watch push failed"),
      // `start` and `update` carry the same frame, so an update identical to the
      // start that preceded it is a duplicate too.
      frameHash: (f) => `${f.event === "end" ? "end" : "live"}:${watchStateHash(f.state)}`,
    });
  }

  isConfigured(): boolean {
    return this.transport !== null;
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  /** Fan an alert out to every Android device the user registered. Returns sends that succeeded. */
  async sendAlert(userId: string, input: AlertInput): Promise<number> {
    if (!this.transport) return 0;
    const devices = await this.store.listDevices(userId);
    if (devices.length === 0) return 0;
    const results = await Promise.allSettled(
      devices.map(async (d) => {
        const message = buildFcmAlertMessage(input, { serverId: d.clientServerId });
        const result = await this.transport!.send({ ...message, token: d.token });
        await this.settleDevice(d.id, d.token, userId, result);
        return result.ok;
      }),
    );
    return results.filter((r) => r.status === "fulfilled" && r.value).length;
  }

  /** Book one send; resolves `true` when the device row was dropped. */
  private async settleDevice(
    id: string,
    token: string,
    userId: string,
    result: FcmSendResult,
  ): Promise<boolean> {
    if (result.ok) {
      await this.store.recordDeviceResult(id, true);
      return false;
    }
    if (result.serverSide) {
      const nowMs = this.now().getTime();
      if (nowMs - this.lastServerFailureLog >= SERVER_FAILURE_LOG_INTERVAL_MS) {
        this.lastServerFailureLog = nowMs;
        logger.error(
          { status: result.status, reason: result.reason, message: result.message },
          "FCM: send rejected for the server's credentials — check the service account / project id",
        );
      }
      return false;
    }
    if (isUnregisteredFcmResult(result)) {
      logger.info({ userId, token: mask(token), reason: result.reason }, "FCM: dropping device");
      await this.store.deleteDevice(id);
      return true;
    }
    const count = await this.store.recordDeviceResult(id, false);
    if (count >= FCM_MAX_FAILURE_COUNT) {
      logger.warn({ userId, token: mask(token), count }, "FCM: dropping device after failures");
      await this.store.deleteDevice(id);
      return true;
    }
    logger.warn(
      { userId, token: mask(token), status: result.status, reason: result.reason },
      "FCM: send failed",
    );
    return false;
  }

  // ── Watch ─────────────────────────────────────────────────────────────────

  /**
   * Whether a Watch may be showing on the user's devices: they have some, and
   * the server hasn't ended the Watch since it last started one (unknown
   * counts as "may be" — so the first quiet spell after a restart still ends
   * a Watch the previous process started).
   */
  async hasWatch(userId: string): Promise<boolean> {
    if (!this.transport) return false;
    if (this.watch.get(userId) === "ended") return false;
    return (await this.store.listDevices(userId)).length > 0;
  }

  /**
   * An active frame (something running or needing you): `start` when the
   * server hasn't started a Watch for the user, `update` otherwise. HIGH
   * priority when the frame alerts.
   */
  async pushWatch(userId: string, state: WatchState, opts: { alert: boolean }): Promise<void> {
    if (!this.transport) return;
    const devices = await this.store.listDevices(userId);
    if (devices.length === 0) return;
    const event: WatchFrameEvent = this.watch.get(userId) === "live" ? "update" : "start";
    this.watch.set(userId, "live");
    await this.fanOutFrame(devices, userId, event, state, opts.alert);
  }

  /** The final `done` frame after the quiet grace period. */
  async endWatch(userId: string, state: WatchState): Promise<void> {
    if (!this.transport) return;
    this.watch.set(userId, "ended");
    const devices = await this.store.listDevices(userId);
    if (devices.length === 0) return;
    await this.fanOutFrame(devices, userId, "end", state, false);
  }

  private async fanOutFrame(
    devices: FcmDeviceRow[],
    userId: string,
    event: WatchFrameEvent,
    state: WatchState,
    alert: boolean,
  ): Promise<void> {
    await Promise.allSettled(
      devices.map((d) =>
        this.frames.push(
          d.id,
          { token: d.token, userId, serverId: d.clientServerId },
          { event, state, alert: alert ? true : null },
        ),
      ),
    );
  }

  /** Cancel pending timers and forget Watch / dedupe state (tests, shutdown). */
  reset(): void {
    this.frames.reset();
    this.watch.clear();
  }

  async close(): Promise<void> {
    this.reset();
    await this.transport?.close();
  }
}

function mask(token: string): string {
  return token.length <= 12 ? "…" : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

// ── Singleton wired from the environment ───────────────────────────────────

function buildDefaultService(): FcmService {
  if (process.env.OPTIO_FCM_TRANSPORT === "fake") {
    logger.info("FCM: using fake transport (OPTIO_FCM_TRANSPORT=fake)");
    const outboxFile = process.env.OPTIO_FCM_FAKE_OUTBOX?.trim() || undefined;
    return new FcmService({
      transport: new FakeFcmTransport({
        outboxFile,
        onSend: (req) => logger.debug({ fcm: req }, "FCM (fake): recorded send"),
      }),
      store: drizzleFcmStore,
    });
  }
  const config = readFcmConfigFromEnv();
  if (!config) {
    logger.info("FCM not configured — Android push disabled");
    return new FcmService({ transport: null, store: drizzleFcmStore });
  }
  logger.info(
    { projectId: config.projectId, clientEmail: config.serviceAccount.clientEmail },
    "FCM configured",
  );
  return new FcmService({
    transport: new FcmHttpTransport({
      projectId: config.projectId,
      serviceAccount: config.serviceAccount,
    }),
    store: drizzleFcmStore,
  });
}

export const fcmService: FcmService = buildDefaultService();

export function isFcmConfigured(): boolean {
  return fcmService.isConfigured();
}
