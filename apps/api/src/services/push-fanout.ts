/**
 * One notification fan-out over the native push providers: APNs for the iOS
 * app (apns-service.ts) and FCM for the Android app (fcm-service.ts).
 *
 * glance-service.ts decides *what* to push — an alert (after the per-user
 * preference check), an active Watch frame, the end of the Watch — and hands
 * each decision to every configured provider here. Each provider owns its
 * wire format, per-token throttling and bad-token handling, and maps the
 * decision onto its platform:
 *
 *   - APNs: a Live Activity `update` when the phone registered an ActivityKit
 *     token, else push-to-start on the first running agent (or an alert);
 *     `end` to the live tokens.
 *   - FCM: `start` / `update` / `end` data messages to every Android device of
 *     the user (Android has no per-activity tokens; the app decides what to show).
 *
 * A provider that throws is logged and never blocks the other.
 */
import type { WatchState } from "@optio/shared";
import { logger } from "../logger.js";
import type { AlertInput, LiveActivityAlert } from "./apns-payloads.js";
import { apnsService } from "./apns-service.js";
import { fcmService } from "./fcm-service.js";

export type PushProviderName = "apns" | "fcm";

export interface WatchPushOptions {
  /** Present → the frame alerts (the island rings on iOS; HIGH priority on Android). */
  alert: LiveActivityAlert | null;
  /** No agent terminal was running before this frame — the push-to-start moment. */
  firstRunning: boolean;
}

export interface PushProvider {
  readonly name: PushProviderName;
  isConfigured(): boolean;
  /** Fan an alert out to the user's devices; resolves the number of accepted sends. */
  sendAlert(userId: string, input: AlertInput): Promise<number>;
  /** Whether a Watch may be showing for the user (gates `end` and refresh-only frames). */
  hasWatch(userId: string): Promise<boolean>;
  /** An active frame: something is running or needs the user. */
  pushWatch(userId: string, state: WatchState, opts: WatchPushOptions): Promise<void>;
  /** The final `done` frame once everything has been quiet for the grace period. */
  endWatch(userId: string, state: WatchState): Promise<void>;
}

export const apnsPushProvider: PushProvider = {
  name: "apns",
  isConfigured: () => apnsService.isConfigured(),
  sendAlert: (userId, input) => apnsService.sendAlert(userId, input),
  hasWatch: (userId) => apnsService.hasWatchToken(userId),
  async pushWatch(userId, state, { alert, firstRunning }) {
    if (await apnsService.hasWatchToken(userId)) {
      await apnsService.updateWatch(userId, state, { event: "update", alert });
    } else if (firstRunning || alert) {
      // First running terminal (or something needing you) and no live Watch:
      // start one if the device gave us a push-to-start token.
      await apnsService.startWatch(userId, state, { alert });
    }
  },
  endWatch: (userId, state) => apnsService.updateWatch(userId, state, { event: "end" }),
};

export const fcmPushProvider: PushProvider = {
  name: "fcm",
  isConfigured: () => fcmService.isConfigured(),
  sendAlert: (userId, input) => fcmService.sendAlert(userId, input),
  hasWatch: (userId) => fcmService.hasWatch(userId),
  pushWatch: (userId, state, { alert }) => fcmService.pushWatch(userId, state, { alert: !!alert }),
  endWatch: (userId, state) => fcmService.endWatch(userId, state),
};

const PROVIDERS: readonly PushProvider[] = [apnsPushProvider, fcmPushProvider];

/** Providers holding credentials (or a fake transport), in a stable order: APNs, then FCM. */
export function configuredPushProviders(): PushProvider[] {
  return PROVIDERS.filter((p) => p.isConfigured());
}

/** True when any native push provider can send — the glance hooks are no-ops otherwise. */
export function isPushConfigured(): boolean {
  return PROVIDERS.some((p) => p.isConfigured());
}

/**
 * Run `fn` for every provider concurrently. A provider that throws is logged
 * (tagged with `what`) and yields `undefined`; the others are unaffected.
 */
export async function eachProvider<T>(
  providers: readonly PushProvider[],
  what: string,
  fn: (p: PushProvider) => Promise<T>,
): Promise<Array<T | undefined>> {
  const results = await Promise.allSettled(providers.map((p) => fn(p)));
  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    logger.warn({ err: r.reason, provider: providers[i].name }, `push: ${what} failed`);
    return undefined;
  });
}

/** The providers for which `hasWatch(userId)` holds (a failing check counts as no). */
export async function providersWithWatch(
  providers: readonly PushProvider[],
  userId: string,
): Promise<PushProvider[]> {
  const flags = await eachProvider(providers, "Watch check", (p) => p.hasWatch(userId));
  return providers.filter((_, i) => flags[i] === true);
}

/** Send one alert through every configured provider. Resolves accepted sends per provider. */
export async function sendAlertToAll(
  userId: string,
  input: AlertInput,
  providers: readonly PushProvider[] = configuredPushProviders(),
): Promise<Record<PushProviderName, number>> {
  const sent = await eachProvider(providers, "alert", (p) => p.sendAlert(userId, input));
  const out: Record<PushProviderName, number> = { apns: 0, fcm: 0 };
  providers.forEach((p, i) => (out[p.name] += sent[i] ?? 0));
  return out;
}
