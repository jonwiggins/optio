/**
 * APNs transport: the one seam between apns-service and the network.
 *
 * `Apns2Transport` wraps the `apns2` package (HTTP/2 pool, ES256 provider
 * token with rotation, both Apple hosts). `FakeApnsTransport` records sends
 * and returns scripted results for unit tests and `OPTIO_APNS_TRANSPORT=fake`
 * pipeline e2e runs.
 */
import type { ApnsMessage } from "./apns-payloads.js";

export type ApnsEnvironment = "sandbox" | "production";

export interface ApnsSendRequest extends ApnsMessage {
  /** Device or Live Activity token (hex). */
  token: string;
  environment: ApnsEnvironment;
}

export type ApnsSendResult =
  | { ok: true }
  | {
      ok: false;
      /** HTTP status from APNs; 0 when the request never got a response. */
      status: number;
      /** APNs `reason` (e.g. `BadDeviceToken`) or `transport:<message>`. */
      reason: string;
    };

export interface ApnsTransport {
  send(req: ApnsSendRequest): Promise<ApnsSendResult>;
  close(): Promise<void>;
}

export interface Apns2TransportOptions {
  teamId: string;
  keyId: string;
  /** PEM contents of the .p8 signing key. */
  key: string;
  bundleId: string;
  requestTimeoutMs?: number;
}

/** Bad-token reasons that mean "drop the row now", regardless of failure count. */
export const APNS_UNREGISTERED_REASONS = new Set([
  "Unregistered",
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "ExpiredToken",
]);

export function isUnregisteredResult(result: ApnsSendResult): boolean {
  if (result.ok) return false;
  return result.status === 410 || APNS_UNREGISTERED_REASONS.has(result.reason);
}

type Apns2Module = typeof import("apns2");

export class Apns2Transport implements ApnsTransport {
  private clients = new Map<ApnsEnvironment, Promise<InstanceType<Apns2Module["ApnsClient"]>>>();
  private modPromise: Promise<Apns2Module> | null = null;

  constructor(private readonly opts: Apns2TransportOptions) {}

  private mod(): Promise<Apns2Module> {
    this.modPromise ??= import("apns2");
    return this.modPromise;
  }

  private async client(env: ApnsEnvironment) {
    let pending = this.clients.get(env);
    if (!pending) {
      pending = this.mod().then(
        (m) =>
          new m.ApnsClient({
            team: this.opts.teamId,
            keyId: this.opts.keyId,
            signingKey: this.opts.key,
            defaultTopic: this.opts.bundleId,
            host: env === "production" ? m.Host.production : m.Host.development,
            requestTimeout: this.opts.requestTimeoutMs ?? 10_000,
            keepAlive: true,
          }),
      );
      this.clients.set(env, pending);
    }
    return pending;
  }

  async send(req: ApnsSendRequest): Promise<ApnsSendResult> {
    const m = await this.mod();
    const client = await this.client(req.environment);
    const { aps, ...data } = req.payload as { aps: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    const notification = new m.Notification(req.token, {
      type: req.pushType as (typeof m.PushType)[keyof typeof m.PushType],
      topic: req.topic,
      priority: req.priority as (typeof m.Priority)[keyof typeof m.Priority],
      expiration: req.expiration,
      collapseId: req.collapseId,
      aps,
      data,
    });
    try {
      await client.send(notification);
      return { ok: true };
    } catch (err) {
      if (err instanceof m.ApnsError) {
        return { ok: false, status: err.statusCode, reason: err.reason };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, reason: `transport:${message}` };
    }
  }

  async close(): Promise<void> {
    const clients = await Promise.allSettled([...this.clients.values()]);
    this.clients.clear();
    for (const c of clients) {
      if (c.status === "fulfilled") await c.value.close().catch(() => {});
    }
  }
}

/** In-memory transport: records every send; per-token scripted failures. */
export class FakeApnsTransport implements ApnsTransport {
  readonly sent: ApnsSendRequest[] = [];
  private failures = new Map<string, ApnsSendResult>();

  /** Make every send to `token` return `result` until cleared. */
  failToken(token: string, result: Exclude<ApnsSendResult, { ok: true }>): void {
    this.failures.set(token, result);
  }

  clearFailure(token: string): void {
    this.failures.delete(token);
  }

  async send(req: ApnsSendRequest): Promise<ApnsSendResult> {
    this.sent.push(req);
    return this.failures.get(req.token) ?? { ok: true };
  }

  async close(): Promise<void> {
    this.sent.length = 0;
    this.failures.clear();
  }

  /** Sends filtered by push type, newest last. */
  ofType(pushType: ApnsMessage["pushType"]): ApnsSendRequest[] {
    return this.sent.filter((s) => s.pushType === pushType);
  }
}
