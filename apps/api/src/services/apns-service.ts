/**
 * APNs delivery for the iOS app: alert fan-out to a user's devices and Live
 * Activity start / update / end for the per-user "Watch"
 * (docs/design/ios-glanceable-architecture.md §3).
 *
 * Configuration (token-based auth, no certificates):
 *   OPTIO_APNS_KEY_ID, OPTIO_APNS_TEAM_ID, OPTIO_APNS_KEY (PEM .p8 contents)
 *   or OPTIO_APNS_KEY_FILE, OPTIO_APNS_BUNDLE_ID (default dev.optio.ios),
 *   OPTIO_APNS_ENVIRONMENT (default sandbox; the per-row environment wins),
 *   OPTIO_APNS_TRANSPORT=fake (tests/e2e: record instead of send).
 * Unset → `isConfigured()` is false and every method is a no-op, exactly like
 * VAPID in notification-service.ts.
 *
 * Delivery discipline (mirrors push_subscriptions):
 *   - per-token trailing-edge coalescing of LA updates (≤1 push / s / token)
 *   - content-hash dedupe of LA frames (asOf excluded)
 *     (both in watch-coalescer.ts, shared with the Android FCM Watch)
 *   - `apns-collapse-id` on alerts so bursts collapse on the device
 *   - 410 / BadDeviceToken / Unregistered → delete the row immediately
 *   - 5 consecutive failures → delete; success resets the counter
 *
 * Preference checks (notification-service.shouldNotify) are the caller's job —
 * glance-service.ts routes every alert through them.
 */
import { readFileSync } from "node:fs";
import { logger } from "../logger.js";
import type { WatchAttributes, WatchState } from "@optio/shared";
import {
  buildAlertMessage,
  buildLiveActivityMessage,
  buildLiveActivityStartMessage,
  buildWatchAttributes,
  type AlertInput,
  type ApnsMessage,
  type LiveActivityAlert,
} from "./apns-payloads.js";
import {
  Apns2Transport,
  FakeApnsTransport,
  isUnregisteredResult,
  type ApnsEnvironment,
  type ApnsSendResult,
  type ApnsTransport,
} from "./apns-transport.js";
import { drizzleApnsStore, type ApnsStore, type LiveActivityKind } from "./apns-store.js";
import { WATCH_COALESCE_MS, WatchCoalescer } from "./watch-coalescer.js";

/** Maximum consecutive failures before a token row is removed. */
export const APNS_MAX_FAILURE_COUNT = 5;
/** Minimum spacing between Live Activity pushes to one token. */
export const LIVE_ACTIVITY_COALESCE_MS = WATCH_COALESCE_MS;

export const DEFAULT_APNS_BUNDLE_ID = "dev.optio.ios";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  key: string;
  bundleId: string;
  environment: ApnsEnvironment;
}

export function readApnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const keyId = env.OPTIO_APNS_KEY_ID?.trim() ?? "";
  const teamId = env.OPTIO_APNS_TEAM_ID?.trim() ?? "";
  let key = env.OPTIO_APNS_KEY ?? "";
  if (!key && env.OPTIO_APNS_KEY_FILE) {
    try {
      key = readFileSync(env.OPTIO_APNS_KEY_FILE, "utf8");
    } catch (err) {
      logger.warn({ err, file: env.OPTIO_APNS_KEY_FILE }, "APNs: could not read key file");
    }
  }
  // Helm values often arrive with literal "\n" — normalise so the PEM parses.
  key = key.replaceAll("\\n", "\n").trim();
  if (!keyId || !teamId || !key) return null;
  return {
    keyId,
    teamId,
    key,
    bundleId: env.OPTIO_APNS_BUNDLE_ID?.trim() || DEFAULT_APNS_BUNDLE_ID,
    environment: env.OPTIO_APNS_ENVIRONMENT === "production" ? "production" : "sandbox",
  };
}

export interface UpdateWatchOptions {
  event: "update" | "end";
  alert?: LiveActivityAlert | null;
}

/** One ActivityKit update token, as the coalescer's delivery target. */
interface LiveActivityTarget {
  token: string;
  environment: ApnsEnvironment;
  userId: string;
}

export interface ApnsServiceOptions {
  transport: ApnsTransport | null;
  store: ApnsStore;
  bundleId: string;
  defaultEnvironment?: ApnsEnvironment;
  coalesceMs?: number;
  now?: () => Date;
}

export class ApnsService {
  private readonly transport: ApnsTransport | null;
  private readonly store: ApnsStore;
  readonly bundleId: string;
  readonly defaultEnvironment: ApnsEnvironment;
  private readonly coalesceMs: number;
  private readonly now: () => Date;
  /** Per-token coalescing + dedupe of Live Activity frames (keyed by token row id). */
  private readonly liveActivities: WatchCoalescer<
    LiveActivityTarget,
    LiveActivityAlert,
    ApnsSendResult
  >;

  constructor(opts: ApnsServiceOptions) {
    this.transport = opts.transport;
    this.store = opts.store;
    this.bundleId = opts.bundleId;
    this.defaultEnvironment = opts.defaultEnvironment ?? "sandbox";
    this.coalesceMs = opts.coalesceMs ?? LIVE_ACTIVITY_COALESCE_MS;
    this.now = opts.now ?? (() => new Date());
    this.liveActivities = new WatchCoalescer({
      coalesceMs: this.coalesceMs,
      send: (t, frame) => {
        const message = buildLiveActivityMessage(
          {
            event: frame.event === "end" ? "end" : "update",
            state: frame.state,
            alert: frame.alert,
            now: this.now(),
          },
          { bundleId: this.bundleId },
        );
        return this.transport!.send({ ...message, token: t.token, environment: t.environment });
      },
      settle: (tokenId, t, result) =>
        this.settleLiveActivityToken(tokenId, t.token, t.userId, result),
      onFlushError: (err, t) =>
        logger.warn({ err, userId: t.userId }, "APNs: coalesced Live Activity push failed"),
    });
  }

  isConfigured(): boolean {
    return this.transport !== null;
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  /** Fan an alert out to every device the user registered. Returns sends that succeeded. */
  async sendAlert(userId: string, input: AlertInput): Promise<number> {
    if (!this.transport) return 0;
    const devices = await this.store.listDevices(userId);
    if (devices.length === 0) return 0;
    const message = buildAlertMessage(input, { bundleId: this.bundleId, now: this.now() });

    const results = await Promise.allSettled(
      devices.map(async (d) => {
        const result = await this.transport!.send({
          ...message,
          token: d.token,
          environment: d.environment,
        });
        await this.settleDevice(d.id, d.token, userId, result);
        return result.ok;
      }),
    );
    return results.filter((r) => r.status === "fulfilled" && r.value).length;
  }

  private async settleDevice(
    id: string,
    token: string,
    userId: string,
    result: ApnsSendResult,
  ): Promise<void> {
    if (result.ok) {
      await this.store.recordDeviceResult(id, true);
      return;
    }
    if (isUnregisteredResult(result)) {
      logger.info({ userId, token: mask(token), reason: result.reason }, "APNs: dropping device");
      await this.store.deleteDevice(id);
      return;
    }
    const count = await this.store.recordDeviceResult(id, false);
    if (count >= APNS_MAX_FAILURE_COUNT) {
      logger.warn({ userId, token: mask(token), count }, "APNs: dropping device after failures");
      await this.store.deleteDevice(id);
    } else {
      logger.warn(
        { userId, token: mask(token), status: result.status, reason: result.reason },
        "APNs: alert failed",
      );
    }
  }

  // ── Live Activity ─────────────────────────────────────────────────────────

  async hasWatchToken(userId: string, kind: LiveActivityKind = "watch"): Promise<boolean> {
    if (!this.transport) return false;
    const rows = await this.store.listLiveActivityTokens(userId, kind);
    return rows.length > 0;
  }

  async hasStartToken(userId: string, kind: LiveActivityKind = "watch"): Promise<boolean> {
    if (!this.transport) return false;
    const rows = await this.store.listStartTokens(userId, kind);
    return rows.length > 0;
  }

  /**
   * Push a Watch frame to every Live Activity token the user has. Per token:
   * identical frames are dropped, and pushes are spaced ≥ coalesceMs apart
   * (trailing edge — the latest frame always lands). `end` bypasses dedupe.
   */
  async updateWatch(userId: string, state: WatchState, opts: UpdateWatchOptions): Promise<void> {
    if (!this.transport) return;
    const tokens = await this.store.listLiveActivityTokens(userId, "watch");
    if (tokens.length === 0) return;
    await Promise.allSettled(
      tokens.map((t) =>
        this.liveActivities.push(
          t.id,
          { token: t.token, environment: t.environment, userId },
          { event: opts.event, state, alert: opts.alert },
        ),
      ),
    );
  }

  /** Book a Live Activity send; resolves `true` when the token row was dropped. */
  private async settleLiveActivityToken(
    id: string,
    token: string,
    userId: string,
    result: ApnsSendResult,
  ): Promise<boolean> {
    if (result.ok) {
      await this.store.recordLiveActivityResult(id, true);
      return false;
    }
    if (isUnregisteredResult(result)) {
      logger.info({ userId, token: mask(token), reason: result.reason }, "APNs: dropping LA token");
      await this.store.deleteLiveActivityToken(id);
      return true;
    }
    const count = await this.store.recordLiveActivityResult(id, false);
    if (count >= APNS_MAX_FAILURE_COUNT) {
      logger.warn({ userId, token: mask(token), count }, "APNs: dropping LA token after failures");
      await this.store.deleteLiveActivityToken(id);
      return true;
    }
    logger.warn(
      { userId, token: mask(token), status: result.status, reason: result.reason },
      "APNs: Live Activity push failed",
    );
    return false;
  }

  /**
   * Start a Watch on every device that gave us a push-to-start token. Returns
   * the number of accepted sends. Bad start tokens are dropped immediately;
   * other failures are logged (start tokens have no failure counter — the app
   * re-registers them on every launch).
   */
  async startWatch(
    userId: string,
    state: WatchState,
    opts: { attributes?: WatchAttributes; alert?: LiveActivityAlert | null } = {},
  ): Promise<number> {
    if (!this.transport) return 0;
    const tokens = await this.store.listStartTokens(userId, "watch");
    if (tokens.length === 0) return 0;
    const attributes = opts.attributes ?? buildWatchAttributes(userId, this.now());
    const message = buildLiveActivityStartMessage(
      { attributes, state, alert: opts.alert, now: this.now() },
      { bundleId: this.bundleId },
    );
    let sent = 0;
    await Promise.allSettled(
      tokens.map(async (t) => {
        const result = await this.transport!.send({
          ...message,
          token: t.token,
          environment: t.environment,
        });
        if (result.ok) {
          sent++;
          return;
        }
        if (isUnregisteredResult(result)) {
          logger.info({ userId, reason: result.reason }, "APNs: dropping push-to-start token");
          await this.store.deleteStartToken(t.id);
        } else {
          logger.warn(
            { userId, status: result.status, reason: result.reason },
            "APNs: push-to-start failed",
          );
        }
      }),
    );
    return sent;
  }

  /** Send a raw message to one token — used by the test route. */
  async sendRaw(token: string, environment: ApnsEnvironment, message: ApnsMessage) {
    if (!this.transport) return { ok: false, status: 0, reason: "unconfigured" } as const;
    return this.transport.send({ ...message, token, environment });
  }

  /** Cancel pending timers and forget dedupe state (tests, shutdown). */
  reset(): void {
    this.liveActivities.reset();
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

function buildDefaultService(): ApnsService {
  const config = readApnsConfigFromEnv();
  const wantFake = process.env.OPTIO_APNS_TRANSPORT === "fake";
  if (wantFake) {
    logger.info("APNs: using fake transport (OPTIO_APNS_TRANSPORT=fake)");
    return new ApnsService({
      transport: new FakeApnsTransport(),
      store: drizzleApnsStore,
      bundleId: config?.bundleId ?? (process.env.OPTIO_APNS_BUNDLE_ID || DEFAULT_APNS_BUNDLE_ID),
      defaultEnvironment: config?.environment ?? "sandbox",
    });
  }
  if (!config) {
    logger.info("APNs key not set — iOS push notifications disabled");
    return new ApnsService({
      transport: null,
      store: drizzleApnsStore,
      bundleId: process.env.OPTIO_APNS_BUNDLE_ID || DEFAULT_APNS_BUNDLE_ID,
    });
  }
  logger.info(
    { bundleId: config.bundleId, environment: config.environment, keyId: config.keyId },
    "APNs configured",
  );
  return new ApnsService({
    transport: new Apns2Transport({
      teamId: config.teamId,
      keyId: config.keyId,
      key: config.key,
      bundleId: config.bundleId,
    }),
    store: drizzleApnsStore,
    bundleId: config.bundleId,
    defaultEnvironment: config.environment,
  });
}

export const apnsService: ApnsService = buildDefaultService();

export function isApnsConfigured(): boolean {
  return apnsService.isConfigured();
}

/** The environment new registrations default to when the client omits it. */
export function defaultApnsEnvironment(): ApnsEnvironment {
  return apnsService.defaultEnvironment;
}
