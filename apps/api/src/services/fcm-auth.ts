/**
 * Google OAuth2 for FCM HTTP v1 with a service-account key — no SDK: the
 * RS256 JWT is signed with `node:crypto` and exchanged at Google's token
 * endpoint for a one-hour access token (the "JWT bearer" grant, RFC 7523).
 * The token is cached until shortly before it expires, concurrent callers
 * share one exchange, and a failed exchange is remembered briefly so a broken
 * key doesn't turn every push into a token request.
 */
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FCM_OAUTH_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** Assertion lifetime; Google caps it at one hour. */
const JWT_LIFETIME_SEC = 60 * 60;
/** Refresh this long before the access token expires. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** After a failed exchange, fail fast for this long before trying again. */
export const TOKEN_FAILURE_BACKOFF_MS = 30_000;

/** The parts of a Google service-account key file (JSON) this needs. */
export interface GoogleServiceAccount {
  clientEmail: string;
  /** PEM (PKCS#8) private key. */
  privateKey: string;
  privateKeyId?: string;
  projectId?: string;
}

export class ServiceAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceAccountError";
  }
}

/**
 * Parse a service-account key: the JSON Firebase / Google Cloud downloads
 * (base64 of it is accepted too). Literal `\n` escapes in the key — common
 * when the JSON went through an env var — are normalised. Throws
 * `ServiceAccountError` with a reason that never includes key material.
 */
export function parseServiceAccount(raw: string): GoogleServiceAccount {
  let text = raw.trim();
  if (!text) throw new ServiceAccountError("empty");
  if (!text.startsWith("{")) {
    const decoded = Buffer.from(text, "base64").toString("utf8").trim();
    if (!decoded.startsWith("{")) throw new ServiceAccountError("not JSON (or base64 JSON)");
    text = decoded;
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ServiceAccountError("not valid JSON");
  }
  const str = (k: string) => (typeof json[k] === "string" ? (json[k] as string).trim() : "");
  if (json.type !== undefined && json.type !== "service_account") {
    throw new ServiceAccountError(`type is "${String(json.type)}", expected "service_account"`);
  }
  const clientEmail = str("client_email");
  const privateKey = str("private_key").replaceAll("\\n", "\n").trim();
  if (!clientEmail) throw new ServiceAccountError("client_email missing");
  if (!privateKey) throw new ServiceAccountError("private_key missing");
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new ServiceAccountError("private_key is not a valid PEM key");
  }
  return {
    clientEmail,
    privateKey,
    privateKeyId: str("private_key_id") || undefined,
    projectId: str("project_id") || undefined,
  };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** The signed RS256 assertion for the JWT bearer grant. */
export function signServiceAccountJwt(
  sa: GoogleServiceAccount,
  opts: { scope?: string; audience?: string; now?: Date; key?: KeyObject } = {},
): string {
  const iat = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(sa.privateKeyId ? { kid: sa.privateKeyId } : {}) };
  const claims = {
    iss: sa.clientEmail,
    scope: opts.scope ?? FCM_OAUTH_SCOPE,
    aud: opts.audience ?? GOOGLE_TOKEN_URL,
    iat,
    exp: iat + JWT_LIFETIME_SEC,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(opts.key ?? sa.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

export class TokenExchangeError extends Error {
  constructor(
    message: string,
    /** HTTP status from the token endpoint; 0 when it never answered. */
    public readonly status: number,
  ) {
    super(message);
    this.name = "TokenExchangeError";
  }
}

export interface AccessTokenProviderOptions {
  serviceAccount: GoogleServiceAccount;
  scope?: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
}

/** Caches one OAuth2 access token for a service account. */
export class GoogleAccessTokenProvider {
  private cached: { token: string; refreshAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private failure: { error: TokenExchangeError; until: number } | null = null;
  private readonly key: KeyObject;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: AccessTokenProviderOptions) {
    this.key = createPrivateKey(opts.serviceAccount.privateKey);
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** A valid access token, exchanging a fresh JWT when the cached one is (nearly) expired. */
  async get(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cached && nowMs < this.cached.refreshAt) return this.cached.token;
    if (this.failure && nowMs < this.failure.until) throw this.failure.error;
    this.inflight ??= this.exchange().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forget the cached token (FCM answered 401 with it). */
  invalidate(): void {
    this.cached = null;
  }

  private async exchange(): Promise<string> {
    const tokenUrl = this.opts.tokenUrl ?? GOOGLE_TOKEN_URL;
    const issuedAt = this.now();
    try {
      const assertion = signServiceAccountJwt(this.opts.serviceAccount, {
        scope: this.opts.scope,
        audience: tokenUrl,
        now: issuedAt,
        key: this.key,
      });
      let res: Response;
      try {
        res = await this.fetchImpl(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }).toString(),
          signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new TokenExchangeError(
          `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
          0,
        );
      }
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (!res.ok || !body.access_token) {
        const why = [body.error, body.error_description].filter(Boolean).join(": ");
        throw new TokenExchangeError(
          `token exchange failed (${res.status})${why ? `: ${why}` : ""}`,
          res.status,
        );
      }
      const lifetimeMs = Math.max(0, Number(body.expires_in ?? 3600) * 1000);
      const margin = Math.min(ACCESS_TOKEN_REFRESH_MARGIN_MS, lifetimeMs / 2);
      this.cached = {
        token: body.access_token,
        refreshAt: issuedAt.getTime() + lifetimeMs - margin,
      };
      this.failure = null;
      return body.access_token;
    } catch (err) {
      const error =
        err instanceof TokenExchangeError ? err : new TokenExchangeError(String(err), 0);
      this.failure = { error, until: this.now().getTime() + TOKEN_FAILURE_BACKOFF_MS };
      throw error;
    }
  }
}
