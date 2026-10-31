/**
 * Credential health (docs/credential-health.md): asking a service about one
 * token. Every function answers with a `CheckOutcome` and never throws; a
 * service that can't be reached is `unknown`, not `error`.
 *
 * Both go through the deployment's outbound guard with redirects refused:
 * the gateway through `model-gateway-service.ts` (`gatewayFetch`), GitLab
 * through `guardedFetch`, as `git-platform/gitlab.ts` does. Answers are
 * size-capped and read through zod.
 */
import { z } from "zod";
import {
  MAX_GATEWAY_BODY_BYTES,
  describeFailure,
  gatewayKeyInfoRaw,
  gatewayTest,
  readCapped,
} from "../model-gateway-service.js";
import type { ModelProviderRow } from "../model-provider-service.js";
import { guardedFetch } from "../../utils/outbound-url.js";
import { type CheckOutcome, gitlabSelfOutcome, keyInfoOutcome } from "./outcome.js";

const REQUEST_TIMEOUT_MS = 15_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchOverride: Fetch | null = null;

/** Tests: route the GitLab calls through a stand-in (null restores the guard). */
export function setCredentialHealthFetchForTests(f: Fetch | null): void {
  fetchOverride = f;
}

function gitlabFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (fetchOverride) return fetchOverride(url, init);
  return guardedFetch(url, { ...init, redirect: "error", timeoutMs: REQUEST_TIMEOUT_MS });
}

const unknown = (reason: string, details: Record<string, unknown> = {}): CheckOutcome => ({
  status: "unknown",
  reason,
  expiresAt: null,
  details,
});

// ── GitLab ───────────────────────────────────────────────────────────────────

/** `GET /personal_access_tokens/self`, as far as the check reads it. */
const tokenSelfSchema = z
  .object({
    name: z.string().max(500).optional(),
    scopes: z.array(z.string().max(100)).max(50).optional(),
    revoked: z.boolean().optional(),
    active: z.boolean().optional(),
    expires_at: z.string().max(40).nullish(),
  })
  .passthrough();

/**
 * One GitLab token against the hosts it may be sent to (gitlab-hosts.ts;
 * the first that accepts it is its own). No host: `unknown`, never a guess.
 */
export async function checkGitLabToken(
  token: string,
  hosts: string[],
  now: Date = new Date(),
): Promise<CheckOutcome> {
  if (!hosts.length) {
    return unknown(
      "No GitLab host to check it against: Optio sends a token only to a GitLab named in GITLAB_HOSTS or by the setup wizard",
    );
  }
  const headers = {
    // Bearer: every GitLab token kind (PRIVATE-TOKEN takes no OAuth token).
    Authorization: `Bearer ${token}`,
    "User-Agent": "Optio",
    Accept: "application/json",
  };
  let refused: { host: string; status: number } | null = null;
  let unreachable: string | null = null;
  for (const host of hosts) {
    let res: Response;
    try {
      res = await gitlabFetch(`https://${host}/api/v4/personal_access_tokens/self`, { headers });
    } catch (err) {
      unreachable = `Couldn't reach GitLab at ${host}: ${describeFailure(err)}`;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      refused = { host, status: res.status };
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      unreachable = `GitLab at ${host} answered ${res.status}`;
      continue;
    }
    let body: unknown = null;
    try {
      const text = await readCapped(res, MAX_GATEWAY_BODY_BYTES);
      body = text === null ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const self = tokenSelfSchema.safeParse(body);
    if (!self.success) {
      unreachable = `GitLab at ${host} answered in another shape`;
      continue;
    }
    return gitlabSelfOutcome(self.data, now, host);
  }
  if (refused) {
    return {
      status: "error",
      reason: `Rejected by GitLab at ${refused.host} (${refused.status})`,
      expiresAt: null,
      details: { host: refused.host },
      invalid: true,
    };
  }
  return unknown(unreachable ?? "GitLab didn't answer");
}

// ── The gateway ──────────────────────────────────────────────────────────────

/**
 * One gateway token against its own gateway (`row`, whose consent the
 * caller already checked): LiteLLM `/key/info` or OpenRouter `/api/v1/key`
 * where the type reports a token's budget; else `/v1/models`, which says
 * only whether it is accepted.
 */
export async function checkGatewayToken(
  row: ModelProviderRow,
  token: string,
  now: Date = new Date(),
): Promise<CheckOutcome> {
  const details = { gateway: row.name };
  let res: { status: number; body: unknown };
  try {
    res = await gatewayKeyInfoRaw(row, token);
  } catch (err) {
    return unknown(`Couldn't reach the gateway: ${describeFailure(err)}`, details);
  }
  const known = keyInfoOutcome(res, now);
  if (known) return { ...known, details: { ...details, ...known.details } };
  const test = await gatewayTest(row, token);
  if (test.ok) {
    return {
      status: "ok",
      reason: "The gateway doesn't report this token's expiry or budget",
      expiresAt: null,
      details,
    };
  }
  if (test.error && /refused the token/.test(test.error)) {
    return {
      status: "error",
      reason: `Rejected by the gateway: ${test.error}`,
      expiresAt: null,
      details,
      invalid: true,
    };
  }
  return unknown(test.error ?? "The gateway didn't answer", details);
}
