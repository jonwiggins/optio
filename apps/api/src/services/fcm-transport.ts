/**
 * FCM transport: the one seam between fcm-service and the network.
 *
 * `FcmHttpTransport` speaks FCM HTTP v1
 * (`POST https://fcm.googleapis.com/v1/projects/<project>/messages:send`)
 * with an OAuth2 access token from the service account (fcm-auth.ts), retrying
 * once with a fresh token on 401. `FakeFcmTransport` records sends and returns
 * scripted results for unit tests and `OPTIO_FCM_TRANSPORT=fake` pipeline e2e
 * runs (optionally appending each request to `OPTIO_FCM_FAKE_OUTBOX` as JSONL,
 * so an out-of-process test can read what the server sent).
 */
import { appendFileSync } from "node:fs";
import type { FcmMessage } from "./fcm-payloads.js";
import { GoogleAccessTokenProvider, type GoogleServiceAccount } from "./fcm-auth.js";

export const FCM_SEND_URL = "https://fcm.googleapis.com/v1/projects/{project}/messages:send";

export interface FcmSendRequest extends FcmMessage {
  /** FCM registration token. */
  token: string;
}

export type FcmSendResult =
  | { ok: true; /** `projects/<p>/messages/<id>` */ name?: string }
  | {
      ok: false;
      /** HTTP status from FCM; 0 when the request never got a response. */
      status: number;
      /**
       * `FcmError.errorCode` (`UNREGISTERED`, `SENDER_ID_MISMATCH`,
       * `QUOTA_EXCEEDED`, …), else the google.rpc status (`INVALID_ARGUMENT`,
       * `NOT_FOUND`, …), else `transport:<message>` / `auth:<message>`.
       */
      reason: string;
      message?: string;
      /** INVALID_ARGUMENT blames `message.token` (a malformed / foreign token). */
      tokenInvalid?: boolean;
      /**
       * Our credentials or configuration failed (token exchange, 401, 403
       * permission): not the device's fault, so its failure counter is untouched.
       */
      serverSide?: boolean;
    };

export type FcmFailure = Exclude<FcmSendResult, { ok: true }>;

export interface FcmTransport {
  send(req: FcmSendRequest): Promise<FcmSendResult>;
  close(): Promise<void>;
}

/** Error codes that mean "this token will never work here — drop the row now". */
export const FCM_UNREGISTERED_REASONS = new Set([
  "UNREGISTERED",
  "NOT_FOUND",
  "SENDER_ID_MISMATCH",
]);

export function isUnregisteredFcmResult(result: FcmSendResult): boolean {
  if (result.ok || result.serverSide) return false;
  if (result.status === 404 || FCM_UNREGISTERED_REASONS.has(result.reason)) return true;
  return result.reason === "INVALID_ARGUMENT" && result.tokenInvalid === true;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{
      "@type"?: string;
      errorCode?: string;
      fieldViolations?: Array<{ field?: string; description?: string }>;
    }>;
  };
}

/** Map an FCM HTTP v1 error response to a send result. */
export function parseFcmError(status: number, bodyText: string): FcmFailure {
  let body: GoogleErrorBody = {};
  try {
    body = JSON.parse(bodyText) as GoogleErrorBody;
  } catch {
    // non-JSON (proxy / HTML error page) — fall back to the status
  }
  const err = body.error ?? {};
  const details = err.details ?? [];
  const fcmCode = details.find((d) =>
    d["@type"]?.endsWith("google.firebase.fcm.v1.FcmError"),
  )?.errorCode;
  const fields = details
    .filter((d) => d["@type"]?.endsWith("google.rpc.BadRequest"))
    .flatMap((d) => d.fieldViolations ?? [])
    .map((v) => v.field ?? "");
  const reason = fcmCode || err.status || `HTTP_${status}`;
  const message = err.message?.slice(0, 300);
  const tokenInvalid =
    reason === "INVALID_ARGUMENT" &&
    (fields.includes("message.token") || /registration token/i.test(message ?? ""));
  const serverSide =
    status === 401 ||
    reason === "THIRD_PARTY_AUTH_ERROR" ||
    (status === 403 && reason !== "SENDER_ID_MISMATCH");
  return {
    ok: false,
    status,
    reason,
    ...(message ? { message } : {}),
    ...(tokenInvalid ? { tokenInvalid } : {}),
    ...(serverSide ? { serverSide } : {}),
  };
}

export interface FcmHttpTransportOptions {
  projectId: string;
  serviceAccount: GoogleServiceAccount;
  fetch?: typeof fetch;
  tokenUrl?: string;
  /** Override the send endpoint (tests); `{project}` is substituted. */
  sendUrl?: string;
  requestTimeoutMs?: number;
  now?: () => Date;
}

export class FcmHttpTransport implements FcmTransport {
  private readonly tokens: GoogleAccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(private readonly opts: FcmHttpTransportOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.tokens = new GoogleAccessTokenProvider({
      serviceAccount: opts.serviceAccount,
      tokenUrl: opts.tokenUrl,
      fetch: this.fetchImpl,
      now: opts.now,
    });
    this.url = (opts.sendUrl ?? FCM_SEND_URL).replace(
      "{project}",
      encodeURIComponent(opts.projectId),
    );
  }

  async send(req: FcmSendRequest): Promise<FcmSendResult> {
    const body = JSON.stringify({
      message: { token: req.token, data: req.data, android: req.android },
    });
    for (let attempt = 0; ; attempt++) {
      let accessToken: string;
      try {
        accessToken = await this.tokens.get();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 0, reason: `auth:${message}`, serverSide: true };
      }
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body,
          signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 10_000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 0, reason: `transport:${message}` };
      }
      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { name?: string };
        return { ok: true, ...(json.name ? { name: json.name } : {}) };
      }
      const failure = parseFcmError(res.status, await res.text().catch(() => ""));
      if (res.status === 401 && attempt === 0) {
        // The cached access token was revoked or expired early: mint a new one once.
        this.tokens.invalidate();
        continue;
      }
      return failure;
    }
  }

  async close(): Promise<void> {
    this.tokens.invalidate();
  }
}

export interface FakeFcmTransportOptions {
  /** Append every request (the HTTP v1 body) to this file as one JSON line. */
  outboxFile?: string;
  onSend?: (req: FcmSendRequest) => void;
}

/** In-memory transport: records every send; per-token scripted failures. */
export class FakeFcmTransport implements FcmTransport {
  readonly sent: FcmSendRequest[] = [];
  private failures = new Map<string, FcmFailure>();

  constructor(private readonly opts: FakeFcmTransportOptions = {}) {}

  /** Make every send to `token` return `result` until cleared. */
  failToken(token: string, result: FcmFailure): void {
    this.failures.set(token, result);
  }

  clearFailure(token: string): void {
    this.failures.delete(token);
  }

  async send(req: FcmSendRequest): Promise<FcmSendResult> {
    this.sent.push(req);
    this.opts.onSend?.(req);
    if (this.opts.outboxFile) {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        message: { token: req.token, data: req.data, android: req.android },
      });
      appendFileSync(this.opts.outboxFile, line + "\n");
    }
    return this.failures.get(req.token) ?? { ok: true, name: `fake/${this.sent.length}` };
  }

  async close(): Promise<void> {
    this.sent.length = 0;
    this.failures.clear();
  }

  /** Sends filtered by `data.type`, oldest first. */
  ofType(type: "alert" | "watch"): FcmSendRequest[] {
    return this.sent.filter((s) => s.data.type === type);
  }
}
